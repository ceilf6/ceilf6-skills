<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.ceilf6.harness-ceilf6-bot</string>
  <key>ProgramArguments</key><array>
    <string>__NODE__</string>
    <string>__ROOT__/src/listener.mjs</string>
    <string>__ROOT__/config.json</string>
  </array>
  <key>WorkingDirectory</key><string>__ROOT__</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <!-- stdout/stderr 由 xpcproxy 在 exec 前打开，它没有 TCC 的桌面/文稿目录授权：
       这两个路径一旦落在 ~/Desktop、~/Documents 等受保护目录下，launchd 会以 78（EX_CONFIG）
       静默拒绝拉起，日志里一行都不会有。install.sh 把它们钉在 ~/Library/Logs 下并回链到 logs/。 -->
  <key>StandardOutPath</key><string>__LOGS__/launchd.out.log</string>
  <key>StandardErrorPath</key><string>__LOGS__/launchd.err.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:__PATH_EXTRA__</string>
  </dict>
</dict></plist>
