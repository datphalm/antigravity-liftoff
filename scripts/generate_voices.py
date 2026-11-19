"""
Generate neural AI voiceover lines for Antigravity Cinematic Launcher.
Uses Microsoft Edge Neural TTS (edge-tts) so the launcher runs 100% offline with zero latency.
"""
import asyncio
from pathlib import Path
import edge_tts

OUT_DIR = Path(__file__).parent / "web" / "assets" / "audio"

VOICE_LINES = {
    # British J.A.R.V.I.S.-inspired cinematic AI voice (en-GB-RyanNeural)
    "en_intro.mp3": ("en-GB-RyanNeural", "-6%", "-4Hz", "Antigravity."),
    "en_auth.mp3": ("en-GB-RyanNeural", "-4%", "-3Hz", "Authorization required."),
    "en_verified.mp3": ("en-GB-RyanNeural", "-4%", "-3Hz", "Identity confirmed."),
    "en_init.mp3": ("en-GB-RyanNeural", "-2%", "-3Hz", "Access granted. Initializing Antigravity ecosystem."),
    "en_welcome.mp3": ("en-GB-RyanNeural", "-8%", "-4Hz", "Welcome to Antigravity."),

    # Vietnamese cinematic AI voice (vi-VN-NamMinhNeural)
    "vi_intro.mp3": ("vi-VN-NamMinhNeural", "-4%", "-2Hz", "Antigravity."),
    "vi_auth.mp3": ("vi-VN-NamMinhNeural", "-2%", "-2Hz", "Yêu cầu xác thực quyền truy cập."),
    "vi_verified.mp3": ("vi-VN-NamMinhNeural", "-2%", "-2Hz", "Đã xác minh danh tính."),
    "vi_init.mp3": ("vi-VN-NamMinhNeural", "+0%", "-2Hz", "Chấp nhận quyền hạn. Đang khởi chạy hệ sinh thái Antigravity."),
    "vi_welcome.mp3": ("vi-VN-NamMinhNeural", "-6%", "-3Hz", "Chào mừng đến với Antigravity."),
}


async def generate_all() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tasks = []
    for filename, (voice, rate, pitch, text) in VOICE_LINES.items():
        out_path = OUT_DIR / filename
        communicate = edge_tts.Communicate(text=text, voice=voice, rate=rate, pitch=pitch)
        tasks.append((filename, communicate.save(str(out_path))))

    for filename, coro in tasks:
        await coro
        size_kb = (OUT_DIR / filename).stat().st_size / 1024
        print(f"Generated {filename} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    asyncio.run(generate_all())
