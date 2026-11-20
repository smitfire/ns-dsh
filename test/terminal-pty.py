#!/usr/bin/env python3
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get("NODE_BIN") or shutil.which("node") or str(Path.home() / ".local/share/mise/installs/node/24.19.0/bin/node")
CLI_BIN = str(ROOT / "bin" / "ns-dsh.mjs")
OUT_JSON = Path(os.environ.get("NS_PTY_OUT_JSON", str(ROOT / ".local" / "e2e" / "gate6-terminal-pty.json")))
HOST_PORT = int(os.environ.get("NS_PTY_PORT", "17430"))
FW_PORT = int(os.environ.get("NS_PTY_FW_PORT", "18797"))


def launch_pty(args, env):
    master, slave = pty.openpty()
    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

        def attach_tty():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

        child = subprocess.Popen(
            args,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            env=env,
            cwd=ROOT,
            preexec_fn=attach_tty,
        )
    except Exception:
        for fd_num in (master, slave):
            try:
                os.close(fd_num)
            except OSError:
                pass
        raise
    os.close(slave)
    return child, master


def drain(fd, seconds=0.6):
    chunks = []
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                data = os.read(fd, 65536)
                if not data:
                    break
                chunks.append(data)
            except OSError:
                break
    return b"".join(chunks)


def capture(sock):
    res = subprocess.run(
        ["tmux", "-L", sock, "capture-pane", "-p", "-t", "ns-dsh", "-S", "-120"],
        capture_output=True,
        text=True,
        check=True,
        timeout=5,
    )
    return res.stdout


def send_command(sock, cmd):
    subprocess.run(["tmux", "-L", sock, "send-keys", "-t", "ns-dsh", "-l", cmd], check=True)
    time.sleep(0.12)
    subprocess.run(["tmux", "-L", sock, "send-keys", "-t", "ns-dsh", "C-m"], check=True)


def http_get_json(url):
    with urllib.request.urlopen(url, timeout=5) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def main():
    state_dir = tempfile.mkdtemp(prefix="ns-pty-state-")
    pnpm_dir = str(Path.home() / ".local/share/mise/installs/pnpm/latest")
    existing_path = os.environ.get("PATH", "")
    merged_path = os.pathsep.join([str(Path(NODE).parent), pnpm_dir, existing_path]) if existing_path else os.pathsep.join([str(Path(NODE).parent), pnpm_dir])
    env = dict(os.environ, TERM="xterm-256color", NS_DSH_STATE_DIR=state_dir, NS_BOARD_DB_PATH=os.path.join(state_dir, "board.db"), PATH=merged_path)
    child = None
    fd = None
    try:
        # 1. Idempotent start check + Forewisp JEV /health check
        s1 = json.loads(
            subprocess.check_output(
                [NODE, CLI_BIN, "start", "--port", str(HOST_PORT), "--forewisp-port", str(FW_PORT), "--state-dir", state_dir],
                env=env,
                text=True,
                timeout=40,
            )
        )
        s2 = json.loads(
            subprocess.check_output(
                [NODE, CLI_BIN, "start", "--port", str(HOST_PORT), "--forewisp-port", str(FW_PORT), "--state-dir", state_dir],
                env=env,
                text=True,
                timeout=30,
            )
        )
        assert s1["ok"] and s2["ok"], "start did not succeed"
        assert s1["forewispRunning"], "Forewisp JEV daemon did not start"
        assert s1["panePid"] == s2["panePid"], "Second start spawned a different host panePid"
        sock = s1["tmuxSocket"]
        pid = str(s1["panePid"])
        _, fw_health = http_get_json(f"http://127.0.0.1:{FW_PORT}/health")
        assert fw_health.get("strategy") == "jev", f"Expected jev strategy, got {fw_health}"

        # 2. Real PTY attach
        child, fd = launch_pty([NODE, CLI_BIN, "tui", "--state-dir", state_dir], env)
        drain(fd, 2.0)
        initial_pane = capture(sock)
        assert "ns-dsh" in initial_pane and "Ctrl+O" in initial_pane, f"TUI header/footer did not render:\n{initial_pane}"

        # 3. Slash commands (/status, /plan on, /plan off, /tasks, /context, /cuga, /switchyard)
        send_command(sock, "/status")
        drain(fd, 0.8)
        assert "Forewisp:" in capture(sock)

        send_command(sock, "/plan on")
        drain(fd, 0.6)
        assert "PLAN" in capture(sock)

        send_command(sock, "/plan off")
        drain(fd, 0.6)
        assert "DISABLED" in capture(sock), "Missing /plan off output"
        send_command(sock, "/tasks")
        drain(fd, 0.6)
        tasks_pane = capture(sock)
        assert "Board has" in tasks_pane or "|" in tasks_pane, "Missing /tasks output"
        send_command(sock, "/context")
        drain(fd, 0.6)
        ctx_pane = capture(sock).lower()
        assert "tier" in ctx_pane or "mode" in ctx_pane, "Missing /context output"
        send_command(sock, "/cuga")
        drain(fd, 0.6)
        cuga_pane = capture(sock).lower()
        assert "blocks" in cuga_pane or "step" in cuga_pane or "{" in cuga_pane, "Missing /cuga output"
        send_command(sock, "/switchyard")
        drain(fd, 0.6)
        sw_pane = capture(sock).lower()
        assert "activetier" in sw_pane or "toml" in sw_pane, "Missing /switchyard output"
        send_command(sock, "/orchestrator status")
        drain(fd, 0.6)
        assert "orchestrator" in capture(sock).lower(), "Missing /orchestrator status output"

        # 4. Bracketed Unicode paste check
        os.write(fd, "\x1b[200~Zürich 日本語 café\x1b[201~".encode("utf-8"))
        drain(fd, 0.8)
        pane_u = capture(sock)
        assert "Zürich" in pane_u and "日本語" in pane_u, f"Unicode paste lost:\n{pane_u}"

        # 5. Ctrl+C clears current line without killing host
        os.write(fd, b"\x03")
        drain(fd, 0.6)
        assert (
            subprocess.check_output(
                ["tmux", "-L", sock, "display-message", "-p", "-t", "ns-dsh", "#{pane_pid}"],
                text=True,
                timeout=5,
            ).strip()
            == pid
        )

        # 6. SIGWINCH resize 120x40 -> 80x28 (tmux window height is 27 with status bar, client is 80x28)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 28, 80, 0, 0))
        os.killpg(child.pid, signal.SIGWINCH)
        resized = False
        resize_deadline = time.monotonic() + 3.0
        while time.monotonic() < resize_deadline:
            drain(fd, 0.2)
            client_dims = subprocess.check_output(
                ["tmux", "-L", sock, "list-clients", "-t", "ns-dsh", "-F", "#{client_width}x#{client_height}"],
                text=True,
                timeout=5,
            ).strip()
            win_dims = subprocess.check_output(
                ["tmux", "-L", sock, "display-message", "-p", "-t", "ns-dsh", "#{window_width}x#{window_height}"],
                text=True,
                timeout=5,
            ).strip()
            if client_dims == "80x28" and win_dims in ("80x27", "80x28"):
                resized = True
                break
        assert resized, f"tmux did not resize to 80x28/27 after SIGWINCH (client={client_dims!r}, win={win_dims!r})"

        # 7. /exit detaches cleanly while host + WebUI stay alive
        send_command(sock, "/exit")
        drain(fd, 1.0)
        rc = child.wait(timeout=8)
        assert rc == 0, f"Detach via /exit returned {rc}"
        os.close(fd)
        fd = None
        assert subprocess.run(["tmux", "-L", sock, "has-session", "-t", "ns-dsh"], timeout=5).returncode == 0, "/exit killed host"

        _, board_state = http_get_json(f"http://127.0.0.1:{HOST_PORT}/ns-board/api/state")
        assert "revision" in board_state
        _, tui_status = http_get_json(f"http://127.0.0.1:{HOST_PORT}/ns-tui/api/status")
        session_id = tui_status["sessionId"]

        # 8. Re-attach via --resume <sessionId> and verify identical pane_pid
        child, fd = launch_pty([NODE, CLI_BIN, "tui", "--resume", session_id, "--state-dir", state_dir], env)
        attach_deadline = time.monotonic() + 6.0
        attached = False
        while time.monotonic() < attach_deadline:
            drain(fd, 0.2)
            clients = subprocess.check_output(
                ["tmux", "-L", sock, "list-clients", "-t", "ns-dsh"],
                text=True,
                timeout=5,
            ).strip()
            if clients:
                attached = True
                break
        assert attached, "tmux resume client did not attach within 6s"
        assert (
            subprocess.check_output(
                ["tmux", "-L", sock, "display-message", "-p", "-t", "ns-dsh", "#{pane_pid}"],
                text=True,
                timeout=5,
            ).strip()
            == pid
        )
        os.write(fd, b"\x02d")
        detach_rc = child.wait(timeout=8)
        assert detach_rc == 0, f"Detach via Ctrl+B d returned {detach_rc}"
        os.close(fd)
        fd = None

        OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
        report = {
            "gate": "gate6-terminal-pty",
            "passed": True,
            "port": HOST_PORT,
            "forewispPort": FW_PORT,
            "forewispStrategy": fw_health.get("strategy"),
            "panePid": int(pid),
            "resumedSessionId": session_id,
            "checks": {
                "idempotentStart": True,
                "tuiRender": True,
                "slashCommands": True,
                "orchestratorCommand": True,
                "unicodePaste": True,
                "ctrlCCancel": True,
                "sigwinchResize": True,
                "exitDetachesWebUiAlive": True,
                "resumeSameLiveHost": True,
            },
        }
        OUT_JSON.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report, indent=2))
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if child is not None and child.poll() is None:
            try:
                os.killpg(os.getpgid(child.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                pass
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(child.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    pass
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
        try:
            subprocess.run([NODE, CLI_BIN, "shutdown", "--state-dir", state_dir], env=env, capture_output=True, timeout=20)
        except (subprocess.SubprocessError, OSError):
            pass
        shutil.rmtree(state_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
