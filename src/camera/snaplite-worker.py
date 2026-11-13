import argparse
import json
import os
from pathlib import Path
import struct
import sys
import threading
import time


def camera_devices():
    from pygrabber.dshow_graph import FilterGraph

    # Keep the DirectShow indices, even when excluding the OBS output device.
    return [{"id": index, "name": name} for index, name in enumerate(FilterGraph().get_input_devices())
            if name.casefold() != "obs virtual camera"]


def stream(camera, effect, mirror):
    import cv2
    from snaplite import FPS, HEIGHT, WIDTH, fit_frame
    from lens_runtime import FullLens

    # Release the device if TChat exits without getting to its shutdown hook.
    def watch_parent():
        sys.stdin.buffer.read()
        os._exit(0)

    threading.Thread(target=watch_parent, daemon=True).start()
    capture = cv2.VideoCapture(camera, cv2.CAP_DSHOW)
    lens = None
    try:
        if not capture.isOpened():
            raise RuntimeError("Камера недоступна. Проверьте подключение и закройте другие приложения, которые её используют.")
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, WIDTH)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, HEIGHT)
        capture.set(cv2.CAP_PROP_FPS, FPS)
        if effect == "butterfly":
            lens = FullLens()

        epoch = time.monotonic()
        output = sys.stdout.buffer
        while True:
            started = time.monotonic()
            ok, frame = capture.read()
            if not ok:
                raise RuntimeError("Камера перестала отдавать кадры. Проверьте подключение и запустите её снова.")
            frame = fit_frame(frame)
            if mirror:
                frame = cv2.flip(frame, 1)
            if lens is not None:
                frame = lens.apply(frame, started - epoch)
            ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 82])
            if not ok:
                raise RuntimeError("Не удалось подготовить кадр камеры.")
            output.write(struct.pack(">I", jpeg.nbytes))
            output.write(jpeg)
            output.flush()
            time.sleep(max(0, 1 / FPS - (time.monotonic() - started)))
    finally:
        capture.release()
        if lens is not None:
            lens.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--camera", type=int)
    parser.add_argument("--effect", choices=("none", "butterfly"), default="butterfly")
    parser.add_argument("--mirror", action="store_true")
    args = parser.parse_args()
    sys.path.insert(0, str(args.root))
    if args.list:
        print(json.dumps(camera_devices()))
    else:
        stream(args.camera, args.effect, args.mirror)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("TCHAT_CAMERA_ERROR: " + " ".join(str(error).split()), file=sys.stderr)
        sys.exit(1)
