# silver-ink-perf

**Tiếng Việt** · [English](#english)

Bản vá cho [antigravity-silver-ink-theme](https://github.com/wwm100107-creator/antigravity-silver-ink-theme), dành cho ai thích bản Ultra (video nền, mắt nhìn theo chuột) nhưng máy kêu ù ù mỗi lần mở Antigravity.

```powershell
powershell -ExecutionPolicy Bypass -File extras\silver-ink-perf\apply.ps1
# đổi ý thì trả lại bản gốc:
powershell -ExecutionPolicy Bypass -File extras\silver-ink-perf\apply.ps1 -Revert
```

| i3-1215U, Intel UHD, Antigravity toàn màn hình 1080p | GPU | CPU |
|---|---|---|
| Ultra gốc | 42.9% | 14.8% |
| Ultra đã vá | **22.5%** | **7.8%** |

Đo bằng bộ đếm GPU của Windows, mỗi lần 10 giây.

## Nặng ở chỗ nào

Lúc đầu mình tưởng thủ phạm là video. Hoá ra video chỉ ăn khoảng 12%, còn ba phần tư chi phí nằm ở mấy canvas vẽ đôi mắt.

Thứ nhất, để biết lúc nào nhân vật chớp mắt, theme vẽ khung video vào một canvas phụ rồi gọi `getImageData` ở **mỗi khung hình**. Lệnh đó bắt GPU dừng lại, gửi ảnh về CPU, 30 lần một giây. Nhưng video là một đoạn 25 giây lặp đi lặp lại, nên mỗi khung chỉ cần đo một lần. Giờ kết quả được nhớ lại theo từng khung và lưu vào `localStorage`. Từ vòng thứ hai trở đi, và từ lần mở app sau, không còn lần đọc ngược nào nữa.

Thứ hai, mắt và video cùng chạy 30fps nhưng lệch nhịp nhau, nên trình duyệt vẫn phải ghép hình 60 lần một giây. Giờ mắt được vẽ trong `requestVideoFrameCallback`, đúng lúc video ra khung mới.

Mấy chỗ nhỏ hơn:
- Video nền 60fps được encode lại thành 30fps bằng bộ mã hoá có sẵn của Windows (`transcode.ps1`, không cần ffmpeg).
- Canvas mắt vẽ đúng kích thước hiển thị, thay vì luôn gấp đôi.
- Canvas hiệu ứng vẽ ở 1x.
- Khi Antigravity không được focus, hiệu ứng chạy 15fps.

`core.js` ở đây là bản đã vá của commit `3ecd665` (giấy phép MIT, xem `LICENSE-silver-ink`). Mọi chỗ sửa đều đánh dấu `[patch]`. Nếu theme gốc ra bản mới, chạy `-Revert` trước rồi hẵng vá lại.

---

## English

A patch for [antigravity-silver-ink-theme](https://github.com/wwm100107-creator/antigravity-silver-ink-theme), for anyone who loves Ultra mode (animated background, eyes that follow your cursor) but whose laptop fans spin up every time Antigravity opens.

```powershell
powershell -ExecutionPolicy Bypass -File extras\silver-ink-perf\apply.ps1
# changed your mind:
powershell -ExecutionPolicy Bypass -File extras\silver-ink-perf\apply.ps1 -Revert
```

| i3-1215U, Intel UHD, Antigravity fullscreen at 1080p | GPU | CPU |
|---|---|---|
| Original Ultra | 42.9% | 14.8% |
| Patched Ultra | **22.5%** | **7.8%** |

Measured with Windows GPU counters, 10 seconds per run.

### Where the time was going

I assumed the video was the problem. It turned out to cost only about 12%; three quarters of the load was the canvases that draw the eyes.

First, to know when the character blinks, the theme drew the video frame into a scratch canvas and called `getImageData` on **every frame**. That stalls the GPU and copies pixels back to the CPU, thirty times a second. But the video is the same 25-second loop forever, so each frame only needs to be measured once. Results are now cached per frame and saved to `localStorage`. After the first loop, and on every launch after that, there are no readbacks at all.

Second, the eyes and the video both ran at 30fps but out of phase, so the browser was still compositing 60 times a second. The eyes now draw inside `requestVideoFrameCallback`, exactly when the video produces a new frame.

Smaller fixes:
- The 60fps background video is re-encoded to 30fps with Windows' built-in encoder (`transcode.ps1`, no ffmpeg needed).
- The eye canvas renders at its displayed size instead of always at 2x.
- Effect canvases render at 1x.
- When Antigravity isn't focused, effects drop to 15fps.

`core.js` here is a patched copy of commit `3ecd665` (MIT, see `LICENSE-silver-ink`). Every change is marked `[patch]`. If the upstream theme updates, run `-Revert` first and then apply again.
