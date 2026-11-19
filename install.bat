@echo off
chcp 65001 >nul
echo [1/2] Cai thu vien Python (pywebview, pywin32)...
python -m pip install --disable-pip-version-check -q -r "%~dp0requirements.txt"
echo [2/2] Gan launcher vao shortcut Antigravity...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\integrate_shortcuts.ps1" -Install
pause
