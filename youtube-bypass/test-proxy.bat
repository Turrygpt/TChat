@echo off
cd /d "%~dp0"
title TChat proxy self-test

echo Keep the ByeDPI/Xray window OPEN while this test runs!
echo.

echo === 1) Is something listening on 127.0.0.1:10810? ===
netstat -ano | findstr ":10810"
echo (if nothing above - the proxy is NOT running - open run-byedpi.bat or run-xray.bat)
echo.

echo === 2) YouTube DIRECT (no proxy) ===
curl -s -o nul -w "direct youtube.com: HTTP %%{http_code} in %%{time_total}s\n" --max-time 15 https://www.youtube.com
echo.

echo === 3) YouTube via HTTP proxy ===
curl -s -o nul -w "http  proxy youtube.com: HTTP %%{http_code} in %%{time_total}s\n" --max-time 25 -x http://127.0.0.1:10810 https://www.youtube.com
echo.

echo === 4) YouTube via SOCKS5 proxy ===
curl -s -o nul -w "socks proxy youtube.com: HTTP %%{http_code} in %%{time_total}s\n" --max-time 25 -x socks5h://127.0.0.1:10810 https://www.youtube.com
echo.

echo Done. Send me lines 1, 3 and 4.
pause
