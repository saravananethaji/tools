#!/usr/bin/env python3
"""Run unit and browser tests through one Windows/POSIX-compatible command."""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_until_ready(url: str, process: subprocess.Popen, timeout: int = 60) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"ProjectGraph server exited with {process.returncode}")
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.25)
    raise TimeoutError(f"ProjectGraph server was not ready within {timeout}s")


def main() -> int:
    unit = subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"],
        cwd=ROOT,
        check=False,
    )
    if unit.returncode:
        return unit.returncode

    npx = shutil.which("npx.cmd" if os.name == "nt" else "npx")
    if not npx:
        print("npx not found; install Node.js and run npm install", file=sys.stderr)
        return 2

    port = free_port()
    base_url = f"http://127.0.0.1:{port}"
    server = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_until_ready(f"{base_url}/tree", server)
        env = os.environ.copy()
        env["PROJECTGRAPH_TEST_URL"] = base_url
        browser = subprocess.run(
            [
                npx,
                "playwright",
                "test",
                "test_projects/__e2e__/ui_tests.spec.js",
                "--reporter=line",
            ],
            cwd=ROOT,
            env=env,
            check=False,
        )
        return browser.returncode
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
