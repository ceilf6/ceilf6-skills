import Foundation
import ImageCaptureCore
import ImageIO
import AppKit

// MARK: - CLI Parsing & Help

struct CLIArgs {
    let subcommand: String
    var flags: [String: String] = [:]
    var bools: Set<String> = []
    var positionals: [String] = []

    func str(_ key: String, default def: String = "") -> String { flags[key] ?? def }
    func optStr(_ key: String) -> String? { flags[key] }
    func int(_ key: String, default def: Int) -> Int { flags[key].flatMap(Int.init) ?? def }
    func double(_ key: String, default def: Double) -> Double { flags[key].flatMap(Double.init) ?? def }
    func has(_ key: String) -> Bool { bools.contains(key) || flags[key] == "true" || flags[key] == "1" }
}

func parseCLI() -> CLIArgs {
    let raw = Array(CommandLine.arguments.dropFirst())
    guard let first = raw.first, first != "-h", first != "--help", first != "help" else {
        return CLIArgs(subcommand: "help")
    }
    var out = CLIArgs(subcommand: first)
    let booleanFlags: Set<String> = [
        "raw", "sidecars", "dry-run", "confirm-delete", "json", "prefix-date", "help", "h"
    ]
    var i = 1
    while i < raw.count {
        let arg = raw[i]
        if arg == "-h" || arg == "--help" {
            out.bools.insert("help")
            i += 1
        } else if arg.hasPrefix("--") {
            let trimmed = String(arg.dropFirst(2))
            if let eq = trimmed.firstIndex(of: "=") {
                out.flags[String(trimmed[..<eq])] = String(trimmed[trimmed.index(after: eq)...])
                i += 1
            } else if booleanFlags.contains(trimmed) {
                out.bools.insert(trimmed)
                i += 1
            } else if i + 1 < raw.count && !raw[i + 1].hasPrefix("--") {
                out.flags[trimmed] = raw[i + 1]
                i += 2
            } else {
                out.bools.insert(trimmed)
                i += 1
            }
        } else {
            out.positionals.append(arg)
            i += 1
        }
    }
    return out
}

func printHelp() {
    print("""
    icphoto — macOS ImageCaptureCore CLI for managing USB-connected iPhone/camera photos

    USAGE:
      icphoto <subcommand> [options]

    SUBCOMMANDS:
      status    Inspect connected iPhone/camera status, lock state, iCloud flag, and monthly counts
      catalog   Export full metadata catalog (0ms USB pixel transfer) as TSV
      thumbs    Fetch thumbnails concurrently over USB with filtering & scene time-clustering
      sheets    Stitch local thumbnails into dark-themed 7x6 contact sheets (offline, zero Python)
      gallery   Generate standalone interactive HTML photo gallery with search, lightbox & pick-copier
      export    Download raw originals (+sidecars) or convert HEIC/JPG/PNG with accurate EXIF rotation
      delete    Delete matched items on iPhone (defaults to --dry-run; requires --confirm-delete)

    COMMON CONNECTION OPTIONS:
      --device <substr>        Match device name substring if multiple cameras connected
      --timeout <sec>          Seconds to wait for device & catalog / unlock (default: 25)
      --tz <identifier>        TimeZone for dates & keys (default: system current, e.g. Asia/Shanghai)

    FILTER & MATCH OPTIONS (catalog / thumbs / export / delete):
      --from <YYYY-MM-DD>      Include items on or after date (inclusive)
      --to <YYYY-MM-DD>        Include items on or before date (inclusive)
      --kind <kind>            all | camera | screenshot | edited | image | video (default: all)
      --match <s1,s2,...>      Comma-separated item specs (key, YYYY-MM/NAME, FOLDER/NAME, or NAME)
      --match-file <path>      File with one match spec per line (# comments ignored)

    EXAMPLES:
      icphoto status
      icphoto catalog --out /tmp/iphone_catalog.tsv
      icphoto thumbs --out /tmp/thumbs --kind camera --cluster-minutes 45 --max-edge 360
      icphoto sheets --thumbs /tmp/thumbs --out /tmp/sheets
      icphoto gallery --dir /tmp/thumbs --out /tmp/preview.html --title "候选照片预览"
      icphoto export --out ./picks --match "2023-09/IMG_3683.HEIC,2025-02/IMG_2215.HEIC" --format jpg --max-edge 2200
      icphoto export --out ./raw_backup --from 2026-11-01 --raw --sidecars
      icphoto delete --match "2026-11/IMG_6601.PNG" --dry-run
    """)
}

// MARK: - Media Classification & Keys

enum MediaKind: String {
    case camera, screenshot, edited, video, other
}

func classifyItem(_ f: ICCameraFile) -> MediaKind {
    let uti = (f.uti ?? "").lowercased()
    let upper = (f.name ?? "").uppercased()
    if uti.contains("movie") || uti.contains("video") || upper.hasSuffix(".MOV") || upper.hasSuffix(".MP4") || upper.hasSuffix(".M4V") {
        return .video
    }
    let isImage = uti.contains("image") || upper.hasSuffix(".HEIC") || upper.hasSuffix(".JPG") || upper.hasSuffix(".JPEG") || upper.hasSuffix(".PNG") || upper.hasSuffix(".DNG") || upper.hasSuffix(".WEBP")
    if !isImage { return .other }
    if upper.hasPrefix("IMG_E") { return .edited }
    let hi = max(f.width, f.height), lo = min(f.width, f.height)
    let ratio = lo > 0 ? Double(hi) / Double(lo) : 0.0
    if uti.contains("png") || upper.hasSuffix(".PNG") || ratio > 1.95 {
        return .screenshot
    }
    return .camera
}

func kindMatches(_ itemKind: MediaKind, filter: String) -> Bool {
    switch filter.lowercased() {
    case "", "all": return itemKind != .other
    case "camera", "real-camera", "photo": return itemKind == .camera
    case "screenshot", "screenshots": return itemKind == .screenshot
    case "edited": return itemKind == .edited
    case "image", "images": return itemKind == .camera || itemKind == .screenshot || itemKind == .edited
    case "video", "videos": return itemKind == .video
    case "raw-all": return true
    default:
        fputs("ERROR: Unknown --kind '\(filter)'. Expected all|camera|screenshot|edited|image|video.\n", stderr)
        exit(2)
    }
}

struct DateContext {
    let tz: TimeZone
    let fullFmt = DateFormatter()
    let dayFmt = DateFormatter()
    let ymFmt = DateFormatter()

    init(tzName: String?) {
        if let tzName = tzName, !tzName.isEmpty, tzName != "local", let found = TimeZone(identifier: tzName) {
            self.tz = found
        } else {
            self.tz = TimeZone.current
        }
        let loc = Locale(identifier: "en_US_POSIX")
        for (fmt, pat) in [(fullFmt, "yyyy-MM-dd_HH-mm-ss"), (dayFmt, "yyyy-MM-dd"), (ymFmt, "yyyy-MM")] {
            fmt.locale = loc
            fmt.timeZone = tz
            fmt.dateFormat = pat
        }
    }

    func itemKey(_ f: ICCameraFile) -> String {
        let dt = f.creationDate.map { fullFmt.string(from: $0) } ?? "0000-00-00_00-00-00"
        let folder = (f.parentFolder?.name ?? "ROOT").replacingOccurrences(of: "/", with: "_")
        let name = (f.name ?? "UNKNOWN").replacingOccurrences(of: "/", with: "_")
        return "\(dt)__\(folder)__\(name)"
    }
    func dayString(_ f: ICCameraFile) -> String { f.creationDate.map { dayFmt.string(from: $0) } ?? "0000-00-00" }
    func ymString(_ f: ICCameraFile) -> String { f.creationDate.map { ymFmt.string(from: $0) } ?? "0000-00" }
}

func loadMatchSpecs(_ args: CLIArgs) -> [String] {
    var specs: [String] = []
    if let inline = args.optStr("match") {
        for part in inline.split(separator: ",") {
            let s = part.trimmingCharacters(in: .whitespacesAndNewlines)
            if !s.isEmpty { specs.append(s) }
        }
    }
    if let file = args.optStr("match-file") {
        guard let content = try? String(contentsOfFile: file, encoding: .utf8) else {
            fputs("ERROR: Cannot read --match-file at \(file)\n", stderr)
            exit(2)
        }
        for line in content.components(separatedBy: .newlines) {
            let s = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if !s.isEmpty && !s.hasPrefix("#") { specs.append(s) }
        }
    }
    return specs
}

func loadRenameMap(_ path: String?) -> [String: String] {
    guard let path = path, !path.isEmpty else { return [:] }
    guard let content = try? String(contentsOfFile: path, encoding: .utf8) else {
        fputs("ERROR: Cannot read --rename-map at \(path)\n", stderr)
        exit(2)
    }
    var map: [String: String] = [:]
    for line in content.components(separatedBy: .newlines) {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
        let parts = trimmed.split(separator: "\t", maxSplits: 1).map(String.init)
        if parts.count == 2 {
            map[parts[0].trimmingCharacters(in: .whitespaces)] = parts[1].trimmingCharacters(in: .whitespaces)
        }
    }
    return map
}

func matchesSingleSpec(_ f: ICCameraFile, spec rawSpec: String, ctx: DateContext) -> Bool {
    let spec = rawSpec.trimmingCharacters(in: .whitespacesAndNewlines)
    if spec.isEmpty { return false }
    let key = ctx.itemKey(f)
    if spec.caseInsensitiveCompare(key) == .orderedSame { return true }
    if spec.lowercased().hasSuffix(".jpg"), String(spec.dropLast(4)).caseInsensitiveCompare(key) == .orderedSame {
        return true
    }
    let name = f.name ?? ""
    let stem = (name as NSString).deletingPathExtension
    if spec.contains("/") {
        let parts = spec.split(separator: "/", maxSplits: 1).map(String.init)
        if parts.count == 2 {
            let prefix = parts[0], targetName = parts[1]
            let nameMatch = targetName.caseInsensitiveCompare(name) == .orderedSame
                || targetName.caseInsensitiveCompare(stem) == .orderedSame
            if !nameMatch { return false }
            return prefix == ctx.ymString(f)
                || prefix == ctx.dayString(f)
                || prefix.caseInsensitiveCompare(f.parentFolder?.name ?? "") == .orderedSame
        }
    }
    return spec.caseInsensitiveCompare(name) == .orderedSame
        || spec.caseInsensitiveCompare(stem) == .orderedSame
}

func filterFiles(_ allFiles: [ICCameraFile], args: CLIArgs, ctx: DateContext) -> [ICCameraFile] {
    let fromDate = args.optStr("from")
    let toDate = args.optStr("to")
    let kindFilter = args.str("kind", default: "all")
    return allFiles.filter { f in
        let day = ctx.dayString(f)
        if let from = fromDate, day < from { return false }
        if let to = toDate, day > to { return false }
        return kindMatches(classifyItem(f), filter: kindFilter)
    }
}

// MARK: - Image Conversion & Offline Tools

func convertOrResizeImage(srcPath: String, dstPath: String, format: String, maxEdge: Int, quality: CGFloat) -> (Bool, Int, Int) {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: srcPath) as CFURL, nil) else {
        return (false, 0, 0)
    }
    var opts: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceShouldCacheImmediately: true
    ]
    if maxEdge > 0 {
        opts[kCGImageSourceThumbnailMaxPixelSize] = maxEdge
    } else if let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let pw = props[kCGImagePropertyPixelWidth] as? Int,
              let ph = props[kCGImagePropertyPixelHeight] as? Int {
        opts[kCGImageSourceThumbnailMaxPixelSize] = max(pw, ph)
    } else {
        opts[kCGImageSourceThumbnailMaxPixelSize] = 8192
    }
    guard let cgImg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else {
        return (false, 0, 0)
    }
    let rep = NSBitmapImageRep(cgImage: cgImg)
    let data: Data? = format.lowercased() == "png"
        ? rep.representation(using: .png, properties: [:])
        : rep.representation(using: .jpeg, properties: [.compressionFactor: quality])
    guard let outData = data, (try? outData.write(to: URL(fileURLWithPath: dstPath))) != nil else {
        return (false, 0, 0)
    }
    return (true, cgImg.width, cgImg.height)
}

func runSheets(_ args: CLIArgs) -> Never {
    let thumbDir = args.str("thumbs")
    let sheetDir = args.str("out")
    if thumbDir.isEmpty || sheetDir.isEmpty {
        fputs("ERROR: 'sheets' requires --thumbs <dir> and --out <dir>\n", stderr)
        exit(2)
    }
    try? FileManager.default.createDirectory(atPath: sheetDir, withIntermediateDirectories: true)
    let validExts = Set(["jpg", "jpeg", "png", "webp", "heic"])
    let files = ((try? FileManager.default.contentsOfDirectory(atPath: thumbDir)) ?? [])
        .filter { validExts.contains(($0 as NSString).pathExtension.lowercased()) }
        .sorted()
    if files.isEmpty {
        fputs("WARNING: No image files found in \(thumbDir)\n", stderr)
        exit(0)
    }

    let cols = max(1, args.int("cols", default: 7))
    let rows = max(1, args.int("rows", default: 6))
    let cellW = max(120, args.int("cell-w", default: 240))
    let cellH = max(110, args.int("cell-h", default: 210))
    let labelH = 26, perSheet = cols * rows
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedSystemFont(ofSize: 10.5, weight: .medium),
        .foregroundColor: NSColor(calibratedRed: 0.95, green: 0.88, blue: 0.65, alpha: 1.0)
    ]

    var sIdx = 0, sheetCount = 0
    while sIdx < files.count {
        let chunk = Array(files[sIdx..<min(sIdx + perSheet, files.count)])
        sheetCount += 1
        let firstTag = String(chunk.first!.prefix(10)).replacingOccurrences(of: "/", with: "-")
        let lastTag = String(chunk.last!.prefix(10)).replacingOccurrences(of: "/", with: "-")
        let w = cols * cellW, h = rows * cellH
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ) else {
            fputs("ERROR: Failed to allocate bitmap for contact sheet\n", stderr)
            exit(1)
        }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor(calibratedRed: 0.08, green: 0.09, blue: 0.12, alpha: 1.0).setFill()
        NSRect(x: 0, y: 0, width: w, height: h).fill()

        for (i, fname) in chunk.enumerated() {
            let r = i / cols, c = i % cols
            let x0 = c * cellW, yTop = h - (r + 1) * cellH
            if let img = NSImage(contentsOfFile: "\(thumbDir)/\(fname)"), img.size.width > 0, img.size.height > 0 {
                let maxW = CGFloat(cellW - 8), maxH = CGFloat(cellH - labelH - 6)
                let scale = min(maxW / img.size.width, maxH / img.size.height)
                let dw = img.size.width * scale, dh = img.size.height * scale
                let dx = CGFloat(x0) + (CGFloat(cellW) - dw) / 2.0
                let dy = CGFloat(yTop + labelH) + (maxH - dh) / 2.0
                img.draw(in: NSRect(x: dx, y: dy, width: dw, height: dh))
            }
            let stem = (fname as NSString).deletingPathExtension
            let parts = stem.components(separatedBy: "__")
            let label: String
            if parts.count >= 2 {
                let shortDt = String(parts[0].dropFirst(2).prefix(14)).replacingOccurrences(of: "_", with: " ")
                label = String("\(shortDt) \(parts.last!)".prefix(29))
            } else {
                label = String(stem.prefix(29))
            }
            (label as NSString).draw(at: NSPoint(x: x0 + 5, y: yTop + 6), withAttributes: attrs)
        }
        NSGraphicsContext.restoreGraphicsState()

        let outName = String(format: "sheet_%02d_%@_to_%@.jpg", sheetCount, firstTag, lastTag)
        if let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.82]) {
            try? jpg.write(to: URL(fileURLWithPath: "\(sheetDir)/\(outName)"))
        }
        print("\(sheetDir)/\(outName)")
        sIdx += perSheet
    }
    print("DONE: Generated \(sheetCount) contact sheets from \(files.count) thumbnails.")
    exit(0)
}

func htmlEscape(_ s: String) -> String {
    s.replacingOccurrences(of: "&", with: "&amp;")
     .replacingOccurrences(of: "<", with: "&lt;")
     .replacingOccurrences(of: ">", with: "&gt;")
     .replacingOccurrences(of: "\"", with: "&quot;")
}

func runGallery(_ args: CLIArgs) -> Never {
    let dir = args.str("dir"), outHtml = args.str("out")
    let title = args.str("title", default: "iPhone 照片预览画册")
    if dir.isEmpty || outHtml.isEmpty {
        fputs("ERROR: 'gallery' requires --dir <photos_dir> and --out <file.html>\n", stderr)
        exit(2)
    }
    let skillDir = ProcessInfo.processInfo.environment["ICPHOTO_SKILL_DIR"] ?? ""
    let tplPath = "\(skillDir)/assets/gallery_template.html"
    guard let tpl = try? String(contentsOfFile: tplPath, encoding: .utf8) else {
        fputs("ERROR: Missing gallery template at \(tplPath)\n", stderr)
        exit(1)
    }

    let absDir = URL(fileURLWithPath: dir).standardizedFileURL.path
    let absOut = URL(fileURLWithPath: outHtml).standardizedFileURL.path
    try? FileManager.default.createDirectory(atPath: (absOut as NSString).deletingLastPathComponent, withIntermediateDirectories: true)

    let validExts = Set(["jpg", "jpeg", "png", "webp", "gif"])
    let files = ((try? FileManager.default.contentsOfDirectory(atPath: absDir)) ?? [])
        .filter { validExts.contains(($0 as NSString).pathExtension.lowercased()) }
        .sorted()

    var cardsHtml = ""
    var monthCounts: [String: Int] = [:]
    for f in files {
        let stem = (f as NSString).deletingPathExtension
        let parts = stem.components(separatedBy: "__")
        let dtRaw = parts.first ?? ""
        let month = dtRaw.count >= 7 && dtRaw.dropFirst(4).first == "-" ? String(dtRaw.prefix(7)) : "全部"
        let displayDate = dtRaw.replacingOccurrences(of: "_", with: " ")
        let shortName = parts.count >= 2 ? parts.last! : f
        let fullPath = "\(absDir)/\(f)"
        let encodedPath = fullPath.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? fullPath
        monthCounts[month, default: 0] += 1
        cardsHtml += """
        <div class="card" data-m="\(htmlEscape(month))" data-q="\(htmlEscape((stem + " " + shortName).lowercased()))" data-key="\(htmlEscape(stem))">
          <label class="pick-box" title="勾选加入待导出/待处理清单"><input type="checkbox" class="pick-cb" value="\(htmlEscape(stem))"><span>选择</span></label>
          <img src="file://\(encodedPath)" alt="\(htmlEscape(shortName))" loading="lazy" onclick="openZoom(this.src, '\(htmlEscape(stem))')">
          <div class="meta"><div class="name">\(htmlEscape(shortName))</div><div class="dt">\(htmlEscape(displayDate))</div></div>
        </div>\n
        """
    }

    var monthButtons = "<button class=\"pill active\" data-m=\"ALL\">全部 (\(files.count))</button>\n"
    for m in monthCounts.keys.sorted() where m != "全部" {
        monthButtons += "<button class=\"pill\" data-m=\"\(htmlEscape(m))\">\(htmlEscape(m)) (\(monthCounts[m]!))</button>\n"
    }

    let html = tpl
        .replacingOccurrences(of: "__TITLE__", with: htmlEscape(title))
        .replacingOccurrences(of: "__COUNT__", with: "\(files.count)")
        .replacingOccurrences(of: "__MONTH_BUTTONS__", with: monthButtons)
        .replacingOccurrences(of: "__CARDS__", with: cardsHtml)

    do {
        try html.write(toFile: absOut, atomically: true, encoding: .utf8)
        print(absOut)
        exit(0)
    } catch {
        fputs("ERROR: Failed writing HTML gallery to \(absOut): \(error)\n", stderr)
        exit(1)
    }
}

// MARK: - Camera Session Runner (Online Commands)

final class CameraRunner: NSObject, ICDeviceBrowserDelegate, ICCameraDeviceDelegate {
    let args: CLIArgs
    let ctx: DateContext
    let browser = ICDeviceBrowser()
    var camera: ICCameraDevice?
    var handledReady = false
    var warnedLocked = false

    init(args: CLIArgs) {
        self.args = args
        self.ctx = DateContext(tzName: args.optStr("tz"))
        super.init()
    }

    func start() {
        let timeout = args.double("timeout", default: 25.0)
        browser.delegate = self
        browser.browsedDeviceTypeMask = ICDeviceTypeMask(rawValue:
            ICDeviceTypeMask.camera.rawValue | ICDeviceLocationTypeMask.local.rawValue
        )!
        browser.start()

        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self = self, !self.handledReady else { return }
            if let cam = self.camera {
                if cam.isAccessRestrictedAppleDevice {
                    fputs("ERROR: Timeout waiting for iPhone '\(cam.name ?? "?")' to unlock & trust this Mac.\n", stderr)
                } else {
                    fputs("ERROR: Timeout waiting for complete catalog from '\(cam.name ?? "?")' (progress=\(cam.contentCatalogPercentCompleted)%, filesSoFar=\(cam.mediaFiles?.count ?? 0)). Try unlocking screen or increasing --timeout.\n", stderr)
                }
            } else {
                fputs("ERROR: No USB camera/iPhone detected within \(Int(timeout))s. Check USB data cable and unlock iPhone.\n", stderr)
            }
            exit(1)
        }
    }

    func deviceBrowser(_ browser: ICDeviceBrowser, didAdd device: ICDevice, moreComing: Bool) {
        guard self.camera == nil, let cam = device as? ICCameraDevice else { return }
        if let want = args.optStr("device"), !want.isEmpty, !(cam.name ?? "").localizedCaseInsensitiveContains(want) {
            return
        }
        self.camera = cam
        cam.delegate = self
        if cam.isAccessRestrictedAppleDevice && !warnedLocked {
            warnedLocked = true
            fputs("NOTICE: iPhone '\(cam.name ?? "iPhone")' is locked or untrusted. Unlock iPhone and tap 'Trust' — waiting...\n", stderr)
        }
        cam.requestOpenSession()
    }

    func deviceBrowser(_ browser: ICDeviceBrowser, didRemove device: ICDevice, moreGoing: Bool) {}
    func device(_ device: ICDevice, didOpenSessionWithError error: (any Error)?) {
        if let error = error { fputs("WARNING: openSession reported: \(error.localizedDescription)\n", stderr) }
        if let cam = device as? ICCameraDevice, cam.isAccessRestrictedAppleDevice, !warnedLocked {
            warnedLocked = true
            fputs("NOTICE: iPhone '\(cam.name ?? "iPhone")' is access-restricted. Please unlock iPhone screen...\n", stderr)
        }
    }
    func device(_ device: ICDevice, didCloseSessionWithError error: (any Error)?) {}
    func didRemove(_ device: ICDevice) {}
    func cameraDeviceDidRemoveAccessRestriction(_ device: ICDevice) {
        fputs("NOTICE: iPhone unlocked; loading media catalog...\n", stderr)
    }
    func cameraDeviceDidEnableAccessRestriction(_ device: ICDevice) {}
    func cameraDevice(_ camera: ICCameraDevice, didAdd items: [ICCameraItem]) {}
    func cameraDevice(_ camera: ICCameraDevice, didRemove items: [ICCameraItem]) {}
    func cameraDevice(_ camera: ICCameraDevice, didRenameItems items: [ICCameraItem]) {}
    func cameraDevice(_ camera: ICCameraDevice, didCompleteDeleteFilesWithError error: (any Error)?) {}
    func cameraDeviceDidChangeCapability(_ camera: ICCameraDevice) {}
    func cameraDevice(_ camera: ICCameraDevice, didReceiveThumbnail thumbnail: CGImage?, for item: ICCameraItem, error: (any Error)?) {}
    func cameraDevice(_ camera: ICCameraDevice, didReceiveMetadata metadata: [AnyHashable: Any]?, for item: ICCameraItem, error: (any Error)?) {}
    func cameraDevice(_ camera: ICCameraDevice, didReceivePTPEvent eventData: Data) {}

    func deviceDidBecomeReady(withCompleteContentCatalog device: ICCameraDevice) {
        guard !handledReady, !device.isAccessRestrictedAppleDevice else { return }
        handledReady = true
        let allFiles = (device.mediaFiles ?? [])
            .compactMap { $0 as? ICCameraFile }
            .sorted { ($0.creationDate ?? .distantPast) < ($1.creationDate ?? .distantPast) }

        switch args.subcommand {
        case "status": handleStatus(device: device, allFiles: allFiles)
        case "catalog": handleCatalog(allFiles: allFiles)
        case "thumbs": handleThumbs(allFiles: allFiles)
        case "export": handleExport(allFiles: allFiles)
        case "delete": handleDelete(device: device, allFiles: allFiles)
        default:
            fputs("ERROR: Unknown subcommand '\(args.subcommand)'. Run 'icphoto --help'.\n", stderr)
            exit(2)
        }
    }

    private func handleStatus(device: ICCameraDevice, allFiles: [ICCameraFile]) {
        var byKind: [String: Int] = [:], byMonth: [String: Int] = [:]
        var totalBytes: Int64 = 0
        for f in allFiles {
            byKind[classifyItem(f).rawValue, default: 0] += 1
            byMonth[ctx.ymString(f), default: 0] += 1
            totalBytes += Int64(f.fileSize)
        }
        let canDelete = device.capabilities.contains { $0.lowercased().contains("delete") }
        print("DEVICE: \(device.name ?? "Unknown")")
        print("ACCESS_RESTRICTED: \(device.isAccessRestrictedAppleDevice)")
        print("ICLOUD_PHOTOS_ENABLED: \(device.iCloudPhotosEnabled)")
        print("CAN_DELETE: \(canDelete)")
        print(String(format: "TOTAL_ITEMS: %d (%.2f GB)", allFiles.count, Double(totalBytes) / 1_073_741_824.0))
        print("BY_KIND: camera=\(byKind["camera", default: 0]) screenshot=\(byKind["screenshot", default: 0]) edited=\(byKind["edited", default: 0]) video=\(byKind["video", default: 0]) other=\(byKind["other", default: 0])")
        for ym in byMonth.keys.sorted() { print("MONTH\t\(ym)\t\(byMonth[ym]!)") }
        exit(0)
    }

    private func handleCatalog(allFiles: [ICCameraFile]) {
        let filtered = filterFiles(allFiles, args: args, ctx: ctx)
        var lines: [String] = ["key\tym\tdatetime\tname\tfolder\tkind\tuti\twidth\theight\tbytes\tduration\tsidecars"]
        for f in filtered {
            let dt = f.creationDate.map { ctx.fullFmt.string(from: $0) } ?? ""
            let sidecars = (f.sidecarFiles ?? []).compactMap { $0.name }.joined(separator: ",")
            lines.append("\(ctx.itemKey(f))\t\(ctx.ymString(f))\t\(dt)\t\(f.name ?? "")\t\(f.parentFolder?.name ?? "")\t\(classifyItem(f).rawValue)\t\(f.uti ?? "")\t\(f.width)\t\(f.height)\t\(f.fileSize)\t\(String(format: "%.1f", f.duration))\t\(sidecars)")
        }
        let payload = lines.joined(separator: "\n") + "\n"
        if let outPath = args.optStr("out"), !outPath.isEmpty {
            let dir = (outPath as NSString).deletingLastPathComponent
            if !dir.isEmpty { try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true) }
            do {
                try payload.write(toFile: outPath, atomically: true, encoding: .utf8)
                print("WROTE_CATALOG: \(filtered.count) items -> \(outPath)")
            } catch {
                fputs("ERROR: Failed writing catalog to \(outPath): \(error)\n", stderr)
                exit(1)
            }
        } else {
            print(payload, terminator: "")
        }
        exit(0)
    }

    private func handleThumbs(allFiles: [ICCameraFile]) {
        let outDir = args.str("out")
        if outDir.isEmpty {
            fputs("ERROR: 'thumbs' requires --out <dir>\n", stderr)
            exit(2)
        }
        let fm = FileManager.default
        try? fm.createDirectory(atPath: outDir, withIntermediateDirectories: true)

        let specs = loadMatchSpecs(args)
        var candidates: [ICCameraFile] = !specs.isEmpty
            ? allFiles.filter { f in specs.contains { matchesSingleSpec(f, spec: $0, ctx: ctx) } }
            : filterFiles(allFiles, args: args, ctx: ctx)

        let clusterMin = args.double("cluster-minutes", default: 0)
        if clusterMin > 0 {
            var clustered: [ICCameraFile] = [], lastDate: Date = .distantPast
            for f in candidates {
                let d = f.creationDate ?? .distantPast
                if d.timeIntervalSince(lastDate) >= clusterMin * 60.0 {
                    clustered.append(f)
                    lastDate = d
                }
            }
            candidates = clustered
        }

        var toFetch: [(ICCameraFile, String)] = [], cachedCount = 0
        for f in candidates {
            let dst = "\(outDir)/\(ctx.itemKey(f)).jpg"
            if fm.fileExists(atPath: dst) { cachedCount += 1 } else { toFetch.append((f, dst)) }
        }
        print("THUMBS_PLAN: matched=\(candidates.count) cached=\(cachedCount) fetchOverUSB=\(toFetch.count)")
        fflush(stdout)
        if toFetch.isEmpty { exit(0) }

        let maxEdge = max(120, args.int("max-edge", default: 360))
        let concurrency = max(1, min(8, args.int("concurrency", default: 4)))
        let opts: [ICCameraItemThumbnailOption: Any] = [.imageSourceThumbnailMaxPixelSize: maxEdge]
        let t0 = Date()
        var nextIdx = 0, completed = 0, failed = 0

        func pump() {
            while nextIdx < toFetch.count && (nextIdx - completed) < concurrency {
                let (f, dst) = toFetch[nextIdx]
                nextIdx += 1
                f.requestThumbnailData(options: opts) { data, _ in
                    let ok = data.map { (try? $0.write(to: URL(fileURLWithPath: dst))) != nil } ?? false
                    DispatchQueue.main.async {
                        completed += 1
                        if !ok { failed += 1 }
                        if completed % 100 == 0 || completed == toFetch.count {
                            let elapsed = Date().timeIntervalSince(t0)
                            let rate = elapsed > 0 ? Double(completed) / elapsed : 0
                            print(String(format: "PROGRESS: %d/%d (%.1fs, %.1f imgs/s, failed=%d)", completed, toFetch.count, elapsed, rate, failed))
                            fflush(stdout)
                        }
                        if completed >= toFetch.count {
                            exit(failed > 0 && failed == toFetch.count ? 1 : 0)
                        }
                        pump()
                    }
                }
            }
        }
        pump()
    }

    private func handleExport(allFiles: [ICCameraFile]) {
        let outDir = args.str("out")
        if outDir.isEmpty {
            fputs("ERROR: 'export' requires --out <dir>\n", stderr)
            exit(2)
        }
        let specs = loadMatchSpecs(args)
        let hasDateRange = args.optStr("from") != nil || args.optStr("to") != nil
        if specs.isEmpty && !hasDateRange {
            fputs("ERROR: 'export' requires --match / --match-file or --from / --to so it doesn't accidentally dump the entire phone.\n", stderr)
            exit(2)
        }

        let renameMap = loadRenameMap(args.optStr("rename-map"))
        let isRaw = args.has("raw"), includeSidecars = args.has("sidecars"), prefixDate = args.has("prefix-date")
        let format = args.str("format", default: "jpg").lowercased()
        let maxEdge = args.int("max-edge", default: 2200)
        let quality = CGFloat(args.double("quality", default: 0.88))
        let fm = FileManager.default
        try? fm.createDirectory(atPath: outDir, withIntermediateDirectories: true)

        var queue: [(file: ICCameraFile, customStem: String?)] = []
        if !specs.isEmpty {
            for spec in specs {
                let hits = allFiles.filter { matchesSingleSpec($0, spec: spec, ctx: ctx) }
                if hits.isEmpty {
                    fputs("WARNING: No item matched spec '\(spec)'\n", stderr)
                } else {
                    if hits.count > 1 {
                        let keys = hits.map { ctx.itemKey($0) }.joined(separator: ", ")
                        fputs("WARNING: Spec '\(spec)' matched \(hits.count) items across dates (\(keys)); prefixing dates to prevent overwrite.\n", stderr)
                    }
                    let mapped = renameMap[spec]
                    for h in hits { queue.append((h, hits.count == 1 ? mapped : nil)) }
                }
            }
        } else {
            for f in filterFiles(allFiles, args: args, ctx: ctx) { queue.append((f, renameMap[ctx.itemKey(f)])) }
        }
        if queue.isEmpty {
            fputs("ERROR: 0 items matched for export.\n", stderr)
            exit(1)
        }

        var stemCounts: [String: Int] = [:]
        for item in queue {
            let baseStem = item.customStem ?? ((item.file.name ?? "item") as NSString).deletingPathExtension
            stemCounts[baseStem.lowercased(), default: 0] += 1
        }
        let stagingDir = isRaw ? outDir : "\(outDir)/.icphoto_staging_\(ProcessInfo.processInfo.processIdentifier)"
        try? fm.createDirectory(atPath: stagingDir, withIntermediateDirectories: true)

        var idx = 0, exported = 0
        func next() {
            if idx >= queue.count {
                if !isRaw { try? fm.removeItem(atPath: stagingDir) }
                print("EXPORT_DONE: \(exported)/\(queue.count) items -> \(outDir)")
                exit(exported == queue.count ? 0 : 1)
            }
            let (f, customStem) = queue[idx]
            idx += 1
            let origName = f.name ?? "item"
            let origExt = (origName as NSString).pathExtension
            let baseStem = customStem ?? (origName as NSString).deletingPathExtension
            let needsDisambig = prefixDate || (customStem == nil && (stemCounts[baseStem.lowercased()] ?? 0) > 1)
            let finalStem = needsDisambig ? "\(ctx.dayString(f))_\(baseStem)" : baseStem

            var dlOpts: [ICDownloadOption: Any] = [.downloadsDirectoryURL: URL(fileURLWithPath: stagingDir), .overwrite: true]
            if isRaw {
                dlOpts[.saveAsFilename] = origExt.isEmpty ? finalStem : "\(finalStem).\(origExt)"
                if includeSidecars { dlOpts[ICDownloadOption(rawValue: "ICDownloadSidecarFiles")] = true }
            }
            let itemKeyStr = ctx.itemKey(f)
            f.requestDownload(options: dlOpts) { savedName, err in
                if let savedName = savedName {
                    if isRaw {
                        exported += 1
                        print("RAW [\(idx)/\(queue.count)] \(outDir)/\(savedName)")
                    } else {
                        let rawPath = "\(stagingDir)/\(savedName)"
                        if classifyItem(f) == .video {
                            let dstVideo = "\(outDir)/\(finalStem).\(origExt.isEmpty ? "MOV" : origExt)"
                            try? fm.removeItem(atPath: dstVideo)
                            if (try? fm.moveItem(atPath: rawPath, toPath: dstVideo)) != nil {
                                exported += 1
                                print("VIDEO [\(idx)/\(queue.count)] \(dstVideo)")
                            }
                        } else {
                            let outExt = format == "png" ? "png" : "jpg"
                            let dstImg = "\(outDir)/\(finalStem).\(outExt)"
                            let (ok, w, h) = convertOrResizeImage(srcPath: rawPath, dstPath: dstImg, format: outExt, maxEdge: maxEdge, quality: quality)
                            try? fm.removeItem(atPath: rawPath)
                            if ok {
                                exported += 1
                                print("EXPORTED [\(idx)/\(queue.count)] \(dstImg) (\(w)x\(h))")
                            } else {
                                fputs("ERROR: Failed converting \(origName)\n", stderr)
                            }
                        }
                    }
                } else {
                    fputs("ERROR: Download failed for \(itemKeyStr): \(err?.localizedDescription ?? "unknown")\n", stderr)
                }
                fflush(stdout)
                next()
            }
        }
        next()
    }

    private func handleDelete(device: ICCameraDevice, allFiles: [ICCameraFile]) {
        let specs = loadMatchSpecs(args)
        if specs.isEmpty {
            fputs("ERROR: 'delete' requires explicit --match or --match-file specs (bulk date deletion is disabled for safety).\n", stderr)
            exit(2)
        }
        var targets: [ICCameraFile] = [], seenIDs = Set<ObjectIdentifier>(), hasAmbiguous = false
        for spec in specs {
            let hits = allFiles.filter { matchesSingleSpec($0, spec: spec, ctx: ctx) }
            if hits.isEmpty {
                fputs("WARNING: Spec '\(spec)' matched 0 items on device.\n", stderr)
            } else if hits.count > 1 && !spec.contains("/") && !spec.contains("__") {
                hasAmbiguous = true
                fputs("ERROR: Bare spec '\(spec)' is ambiguous and matched \(hits.count) items across dates:\n", stderr)
                for h in hits { fputs("  -> Use exact key: \(ctx.itemKey(h)) (or \(ctx.ymString(h))/\(h.name ?? ""))\n", stderr) }
            } else {
                for h in hits where seenIDs.insert(ObjectIdentifier(h)).inserted { targets.append(h) }
            }
        }
        if hasAmbiguous {
            fputs("ABORTED: Disambiguate the specs above before deleting.\n", stderr)
            exit(2)
        }
        if targets.isEmpty {
            print("DELETE_PLAN: 0 matching items found.")
            exit(0)
        }

        let totalBytes = targets.reduce(Int64(0)) { $0 + Int64($1.fileSize) }
        print(String(format: "DELETE_TARGETS: %d items (%.2f MB)", targets.count, Double(totalBytes) / 1_048_576.0))
        if device.iCloudPhotosEnabled {
            print("NOTICE: iCloud Photos is ENABLED on this iPhone — deletions via ImageCaptureCore may sync to iCloud Photos or fail on cloud-only items.")
        }
        for t in targets { print("  TARGET\t\(ctx.itemKey(t))\t\(t.width)x\(t.height)\t\(t.fileSize)B") }

        if !args.has("confirm-delete") {
            print("DRY_RUN_COMPLETE: No files were deleted. Pass --confirm-delete after explicit user approval.")
            exit(0)
        }

        let _ = device.requestDeleteFiles(targets, deleteFailed: { failedDict in
            for (reason, item) in failedDict {
                fputs("DELETE_FAILED_ITEM: \(item.name ?? "?") reason=\(reason.rawValue)\n", stderr)
            }
        }, completion: { resultDict, err in
            var okCount = 0, failCount = 0
            for (k, arr) in resultDict {
                let raw = k.rawValue.lowercased()
                if raw.contains("success") { okCount += arr.count }
                else if raw.contains("fail") { failCount += arr.count }
            }
            if let err = err { fputs("DELETE_ERROR: \(err.localizedDescription)\n", stderr) }
            print("DELETE_DONE: deleted=\(okCount) failed=\(failCount)")
            exit(failCount == 0 && err == nil ? 0 : 1)
        })
    }
}

// MARK: - Entry Point

let cli = parseCLI()
if cli.subcommand == "help" || cli.has("help") { printHelp(); exit(0) }
switch cli.subcommand {
case "sheets": runSheets(cli)
case "gallery": runGallery(cli)
case "status", "catalog", "thumbs", "export", "delete":
    let runner = CameraRunner(args: cli)
    runner.start()
    RunLoop.main.run()
default:
    fputs("ERROR: Unknown subcommand '\(cli.subcommand)'. Run 'icphoto --help'.\n", stderr)
    exit(2)
}
