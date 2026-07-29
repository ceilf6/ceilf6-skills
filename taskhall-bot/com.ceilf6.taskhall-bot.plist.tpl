<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ceilf6.taskhall-bot</string>
  <key>ProgramArguments</key><array>
    <string>__NODE__</string>
    <string>__ROOT__/src/listener.mjs</string>
    <string>__ROOT__/config.json</string>
  </array>
  <key>WorkingDirectory</key><string>__ROOT__</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>__ROOT__/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>__ROOT__/logs/launchd.err.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:__PATH_EXTRA__</string>
  </dict>
</dict></plist>
