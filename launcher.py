"""
Antigravity // Singularity Launch Protocol (v2.0)
Zero-flicker, deadlock-free PyWebView2 cinematic launcher with real-time Windows hardware telemetry,
multi-target switching (Antigravity / Antigravity IDE / Antigravity Tools), and clean window handoff.
"""
from __future__ import annotations

import ctypes
import getpass
import json
import os
import platform
import socket
import subprocess
import sys
import threading
import time
import winreg
from pathlib import Path
from typing import Any

# Enable instant Web Audio & AI Voice playback in Edge WebView2 without requiring a click first
os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (
    "--autoplay-policy=no-user-gesture-required --disable-features=msWebOOUI"
)

import webview

try:
    import win32con
    import win32gui
    HAS_WIN32 = True
except ImportError:
    HAS_WIN32 = False


BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
CONFIG_PATH = BASE_DIR / "config.json"
WINDOW_TITLE = "Antigravity // Singularity Protocol"

# IMPORTANT: Keep PyWebView window reference at module level — NEVER as a public attribute
# on js_api, otherwise pywebview recursively inspects WinForms EventArgs.Empty and hits RecursionError!
_ACTIVE_WINDOW: webview.Window | None = None

# --demo: ẩn thông tin máy (tên user, tên máy, thư mục thật) để quay video / chụp ảnh chia sẻ
DEMO_MODE = False
DEMO_WORKSPACES = ["landing-page", "trading-bot", "portfolio-2026", "game-jam"]

DEFAULT_CONFIG: dict[str, Any] = {
    "target": "antigravity",
    "targets": {
        "antigravity": {
            "label": "Antigravity",
            "subtitle": "Agentic OS Core",
            "badge": "CORE",
            "path": os.path.expandvars(r"%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe"),
        },
        "antigravity_ide": {
            "label": "Antigravity IDE",
            "subtitle": "Neural Code Studio",
            "badge": "IDE",
            "path": os.path.expandvars(r"%LOCALAPPDATA%\Programs\Antigravity IDE\Antigravity IDE.exe"),
        },
        "antigravity_tools": {
            "label": "Antigravity Tools",
            "subtitle": "Companion Utility",
            "badge": "TOOLS",
            "path": os.path.expandvars(r"%LOCALAPPDATA%\Antigravity Tools\antigravity-tools.exe"),
        },
    },
    "theme": "silver-ink",
    "voice": "en",
    "auth_mode": "auto",
    "auto_delay": 4,
    "pin_code": "2026",
    "operator_name": "",
    "volume": 0.85,
    "muted": False,
    "ambient_pulse": True,
}


# ---------- Fast Native Win32 Hardware Telemetry ----------
class _MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_ulong),
        ("dwMemoryLoad", ctypes.c_ulong),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


class _FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", ctypes.c_uint32), ("dwHighDateTime", ctypes.c_uint32)]


class _SYSTEM_POWER_STATUS(ctypes.Structure):
    _fields_ = [
        ("ACLineStatus", ctypes.c_byte),
        ("BatteryFlag", ctypes.c_byte),
        ("BatteryLifePercent", ctypes.c_byte),
        ("SystemStatusFlag", ctypes.c_byte),
        ("BatteryLifeTime", ctypes.c_ulong),
        ("BatteryFullLifeTime", ctypes.c_ulong),
    ]


def _ft_to_int(ft: _FILETIME) -> int:
    return (ft.dwHighDateTime << 32) | ft.dwLowDateTime


class _CpuSampler:
    def __init__(self) -> None:
        self._prev_idle = 0
        self._prev_total = 0
        self.sample()

    def sample(self) -> int:
        idle, kernel, user = _FILETIME(), _FILETIME(), _FILETIME()
        try:
            ctypes.windll.kernel32.GetSystemTimes(
                ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)
            )
            i = _ft_to_int(idle)
            t = _ft_to_int(kernel) + _ft_to_int(user)
            di = i - self._prev_idle
            dt = t - self._prev_total
            self._prev_idle, self._prev_total = i, t
            if dt <= 0:
                return 14
            usage = int(round((1.0 - di / dt) * 100))
            return max(1, min(100, usage))
        except Exception:
            return 18


_CPU_SAMPLER = _CpuSampler()


def _get_gpu_name() -> str:
    try:
        candidates: list[str] = []
        for idx in range(5):
            try:
                key = winreg.OpenKey(
                    winreg.HKEY_LOCAL_MACHINE,
                    rf"SYSTEM\CurrentControlSet\Control\Class\{{4d36e968-e325-11ce-bfc1-08002be10318}}\000{idx}",
                )
                desc, _ = winreg.QueryValueEx(key, "DriverDesc")
                winreg.CloseKey(key)
                if desc and "virtual" not in desc.lower() and "basic" not in desc.lower():
                    candidates.append(str(desc))
            except OSError:
                continue
        if candidates:
            # Prefer dedicated NVIDIA/AMD if present, else Intel
            for c in candidates:
                if any(k in c.lower() for k in ("nvidia", "geforce", "rtx", "amd", "radeon")):
                    return c
            return candidates[0]
    except Exception:
        pass
    return "DIRECTX GPU"


_CACHED_GPU = _get_gpu_name()


def _get_ram_power_stats() -> dict[str, Any]:
    mem = _MEMORYSTATUSEX()
    mem.dwLength = ctypes.sizeof(mem)
    ram_pct, ram_used_gb, ram_total_gb = 42, 8.0, 16.0
    try:
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(mem))
        ram_pct = int(mem.dwMemoryLoad)
        ram_total_gb = round(mem.ullTotalPhys / (1024 ** 3), 1)
        ram_used_gb = round((mem.ullTotalPhys - mem.ullAvailPhys) / (1024 ** 3), 1)
    except Exception:
        pass

    pwr = _SYSTEM_POWER_STATUS()
    battery_pct = 100
    ac_online = True
    try:
        ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(pwr))
        if pwr.BatteryLifePercent <= 100:
            battery_pct = int(pwr.BatteryLifePercent)
        ac_online = pwr.ACLineStatus == 1
    except Exception:
        pass

    uptime_min = int(ctypes.windll.kernel32.GetTickCount64() // 60000)
    up_h, up_m = divmod(uptime_min, 60)

    return {
        "cpu_pct": _CPU_SAMPLER.sample(),
        "ram_pct": ram_pct,
        "ram_used_gb": ram_used_gb,
        "ram_total_gb": ram_total_gb,
        "battery_pct": battery_pct,
        "ac_online": ac_online,
        "uptime": f"{up_h:02d}H {up_m:02d}M",
    }


def _list_quick_workspaces() -> list[dict[str, str]]:
    """Return up to 4 real local project folders from Desktop/OneDrive Desktop."""
    items: list[dict[str, str]] = []
    seen: set[str] = set()
    search_roots = [
        Path(os.path.expandvars(r"%USERPROFILE%\OneDrive\Desktop")),
        Path(os.path.expandvars(r"%USERPROFILE%\Desktop")),
    ]
    for root in search_roots:
        if not root.exists():
            continue
        try:
            dirs = sorted(
                [d for d in root.iterdir() if d.is_dir() and not d.name.startswith(".")],
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )
            for d in dirs:
                key = str(d).lower()
                if key in seen:
                    continue
                seen.add(key)
                items.append({"name": d.name, "path": str(d)})
                if len(items) >= 4:
                    return items
        except Exception:
            continue
    return items


def load_config() -> dict[str, Any]:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    # Lần chạy đầu chưa có config.json → lấy từ config.example.json
    source = CONFIG_PATH if CONFIG_PATH.exists() else BASE_DIR / "config.example.json"
    if source.exists():
        try:
            user_cfg = json.loads(source.read_text(encoding="utf-8"))
            for key, val in user_cfg.items():
                if key == "targets" and isinstance(val, dict):
                    for tk, tv in val.items():
                        if tk in cfg["targets"] and isinstance(tv, dict):
                            cfg["targets"][tk].update(tv)
                        else:
                            cfg["targets"][tk] = tv
                else:
                    cfg[key] = val
        except Exception:
            pass
    return cfg


def save_config_file(cfg: dict[str, Any]) -> None:
    try:
        CONFIG_PATH.write_text(
            json.dumps(cfg, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:
        pass


def detect_antigravity_version() -> str:
    candidates = [
        Path(os.path.expandvars(r"%LOCALAPPDATA%\Programs\antigravity\version")),
        Path(os.path.expandvars(r"%LOCALAPPDATA%\Programs\Antigravity IDE\version")),
    ]
    for path in candidates:
        if path.exists():
            try:
                ver = path.read_text(encoding="utf-8").strip()
                if ver:
                    return ver
            except Exception:
                pass
    return "2.0"


def get_system_telemetry(cfg: dict[str, Any]) -> dict[str, Any]:
    raw_user = getpass.getuser()
    operator = (cfg.get("operator_name") or raw_user).strip().upper()
    hostname = socket.gethostname().upper()
    if DEMO_MODE:
        operator, hostname = "YOU", "WORKSTATION"
    win_ver = f"WIN {platform.release()}"
    cpu_cores = os.cpu_count() or 8

    available_targets: dict[str, dict[str, Any]] = {}
    for key, info in cfg.get("targets", {}).items():
        exe_path = os.path.expandvars(info.get("path", ""))
        available_targets[key] = {
            "label": info.get("label", key),
            "subtitle": info.get("subtitle", ""),
            "badge": info.get("badge", "APP"),
            "path": exe_path,
            "exists": Path(exe_path).exists(),
        }

    return {
        "operator": operator,
        "raw_user": raw_user,
        "hostname": hostname,
        "os": win_ver,
        "cores": cpu_cores,
        "gpu": _CACHED_GPU,
        "ag_version": detect_antigravity_version(),
        "targets": available_targets,
        "workspaces": (
            [{"name": n, "path": ""} for n in DEMO_WORKSPACES] if DEMO_MODE else _list_quick_workspaces()
        ),
        "stats": _get_ram_power_stats(),
    }


def find_target_hwnd(target_key: str = "antigravity") -> int | None:
    if not HAS_WIN32:
        return None
    found: list[int] = []
    hint = "antigravity" if "antigravity" in target_key else target_key

    def enum_cb(hwnd: int, _extra: Any) -> bool:
        if not win32gui.IsWindowVisible(hwnd):
            return True
        title = win32gui.GetWindowText(hwnd)
        if not title or title == WINDOW_TITLE:
            return True
        if hint in title.lower():
            try:
                left, top, right, bottom = win32gui.GetWindowRect(hwnd)
                if not win32gui.IsIconic(hwnd) and (right - left < 200 or bottom - top < 150):
                    return True
            except Exception:
                pass
            found.append(hwnd)
        return True

    try:
        win32gui.EnumWindows(enum_cb, None)
    except Exception:
        return None
    exact = [h for h in found if win32gui.GetWindowText(h).strip().lower() == hint]
    return (exact or found or [None])[0]


def focus_window(hwnd: int) -> None:
    if not HAS_WIN32 or not hwnd:
        return
    try:
        if win32gui.IsIconic(hwnd):
            win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        ctypes.windll.user32.AllowSetForegroundWindow(-1)
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        pass


class LauncherAPI:
    """
    Clean PyWebView JS-API bridge.
    ALL internal attributes are prefixed with `_` so PyWebView ONLY exposes the public API methods
    and never recursively traverses CLR/WinForms objects.
    """

    def __init__(
        self,
        preview_mode: bool = False,
        target_override: str | None = None,
        extra_args: list[str] | None = None,
    ) -> None:
        self._preview_mode = preview_mode
        self._config = load_config()
        if target_override and target_override in self._config.get("targets", {}):
            self._config["target"] = target_override
        if DEMO_MODE:
            self._config["auth_mode"] = "biometric"
        self._extra_args = extra_args or []
        self._launched = False
        self._launched_target = self._config.get("target", "antigravity")
        self._closing = False

    def get_bootstrap(self) -> dict[str, Any]:
        return {
            "config": self._config,
            "telemetry": get_system_telemetry(self._config),
            "preview_mode": self._preview_mode,
            "record_audio": bool(DEMO_MODE and os.environ.get("AGL_RECORD_AUDIO")),
        }

    def save_recording(self, wav_b64: str, start_epoch_ms: float) -> dict[str, Any]:
        """Chế độ --demo: lưu âm thanh launcher vừa phát (để ghép vào video demo)."""
        out = os.environ.get("AGL_RECORD_AUDIO")
        if not (DEMO_MODE and out):
            return {"ok": False}
        import base64
        Path(out).write_bytes(base64.b64decode(wav_b64))
        Path(out).with_suffix(".json").write_text(json.dumps({"start_epoch_ms": start_epoch_ms}))
        return {"ok": True}

    def get_live_stats(self) -> dict[str, Any]:
        return _get_ram_power_stats()

    def update_config(self, partial: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "target",
            "theme",
            "voice",
            "auth_mode",
            "pin_code",
            "operator_name",
            "volume",
            "muted",
            "ambient_pulse",
            "auto_delay",
        }
        if isinstance(partial, dict):
            for key, value in partial.items():
                if key in allowed:
                    self._config[key] = value
        if not DEMO_MODE:
            save_config_file(self._config)
        return {
            "ok": True,
            "config": self._config,
            "telemetry": get_system_telemetry(self._config),
        }

    def launch_antigravity(
        self,
        target_key: str | None = None,
        workspace_path: str | None = None,
    ) -> dict[str, Any]:
        if self._preview_mode:
            return {"ok": True, "preview": True, "message": "Preview mode: launch simulated"}

        if self._launched:
            return {"ok": True, "already_launched": True}

        key = target_key or self._config.get("target", "antigravity")
        self._launched_target = key
        target_info = self._config.get("targets", {}).get(key)
        if not target_info:
            return {"ok": False, "error": f"Unknown target: {key}"}

        exe_path = os.path.expandvars(target_info.get("path", ""))
        if not Path(exe_path).exists():
            for alt_info in self._config.get("targets", {}).values():
                alt_path = os.path.expandvars(alt_info.get("path", ""))
                if Path(alt_path).exists():
                    exe_path = alt_path
                    break

        if not Path(exe_path).exists():
            return {"ok": False, "error": f"Executable not found: {exe_path}"}

        # Tham số riêng cho từng app, khai báo trong config.json -> targets.<key>.args
        # (vd: "--remote-debugging-port=0" để theme Silver Ink gắn vào qua CDP)
        target_args = [str(a) for a in target_info.get("args", []) if str(a).strip()]
        cmd_args = [exe_path, *target_args, *self._extra_args]
        if workspace_path and Path(workspace_path).exists():
            cmd_args.append(workspace_path)

        try:
            creation_flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
            subprocess.Popen(
                cmd_args,
                cwd=str(Path(exe_path).parent),
                creationflags=creation_flags,
                close_fds=True,
            )
            self._launched = True
            return {"ok": True, "path": exe_path, "target": key}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def complete_and_exit(self, delay_ms: int = 420) -> dict[str, Any]:
        if self._closing:
            return {"ok": True}
        self._closing = True

        def _close_worker() -> None:
            # Let CSS cinematic iris dissolve finish cleanly
            time.sleep(max(0.08, delay_ms / 1000.0))

            target_hwnd = None
            if not self._preview_mode and self._launched:
                for _ in range(10):
                    target_hwnd = find_target_hwnd(self._launched_target)
                    if target_hwnd:
                        break
                    time.sleep(0.1)

            if _ACTIVE_WINDOW is not None:
                try:
                    _ACTIVE_WINDOW.hide()
                except Exception:
                    pass

            if target_hwnd and not self._preview_mode:
                focus_window(target_hwnd)

            if _ACTIVE_WINDOW is not None:
                try:
                    _ACTIVE_WINDOW.destroy()
                except Exception:
                    pass

            # Guaranteed clean exit failsafe so launcher NEVER hangs in background
            time.sleep(0.25)
            os._exit(0)

        threading.Thread(target=_close_worker, daemon=True).start()
        return {"ok": True}

    def exit_now(self) -> dict[str, Any]:
        return self.complete_and_exit(delay_ms=180)


def parse_cli_args(argv: list[str]) -> tuple[bool, bool, bool, str | None, list[str]]:
    preview_mode = False
    windowed_mode = False
    debug_mode = False
    target_override: str | None = None
    extra_args: list[str] = []

    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--preview":
            preview_mode = True
        elif arg == "--windowed":
            windowed_mode = True
        elif arg == "--debug":
            debug_mode = True
        elif arg == "--target" and i + 1 < len(argv):
            target_override = argv[i + 1]
            i += 1
        else:
            extra_args.append(arg)
        i += 1
    return preview_mode, windowed_mode, debug_mode, target_override, extra_args


def main() -> None:
    global _ACTIVE_WINDOW, DEMO_MODE
    if "--demo" in sys.argv:
        DEMO_MODE = True
        sys.argv.remove("--demo")
    preview_mode, windowed_mode, debug_mode, target_override, extra_args = parse_cli_args(sys.argv[1:])

    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

    api = LauncherAPI(
        preview_mode=preview_mode,
        target_override=target_override,
        extra_args=extra_args,
    )
    index_url = str(WEB_DIR / "index.html")

    window = webview.create_window(
        title=WINDOW_TITLE,
        url=index_url,
        js_api=api,
        width=1366 if windowed_mode else 1920,
        height=780 if windowed_mode else 1080,
        frameless=not windowed_mode,
        fullscreen=not windowed_mode,
        on_top=not windowed_mode,
        resizable=windowed_mode,
        background_color="#03050a",
        text_select=False,
        easy_drag=False,
    )
    _ACTIVE_WINDOW = window

    webview.start(
        gui="edgechromium",
        http_server=True,
        debug=debug_mode,
    )


if __name__ == "__main__":
    main()
