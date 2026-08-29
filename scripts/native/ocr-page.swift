// Apple Vision text recognition for one image, emitted as JSON.
//
// Handwriting recognition happens at the hub, never on the Boox — and this is
// the hub's recogniser. It runs on the Mac mini because Vision is a macOS
// framework and because the subscription CLI plane cannot carry an image (the
// CLIs take a prompt string with tools disabled), so pixels are read here and
// only text travels onward.
//
// Douglas's handwriting is genuinely hard: Vision is reliable on print, lists
// and numbers, and unreliable on cursive prose. That is why every page is
// surfaced for human correction rather than trusted — the per-line confidence
// below is what tells the review surface how much to doubt it.
//
// Usage: ocr-page <image-path>
// Output: {"lines":[{"text":"...","confidence":0.93}],"meanConfidence":0.9}

import Foundation
import Vision
import AppKit

struct Line: Codable { let text: String; let confidence: Double }
struct Result: Codable { let lines: [Line]; let meanConfidence: Double }

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

guard CommandLine.arguments.count > 1 else { fail("usage: ocr-page <image-path>") }
let path = CommandLine.arguments[1]

guard let image = NSImage(contentsOfFile: path),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fail("cannot read image at \(path)")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["en-GB", "en-US"]

do {
    try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request])
} catch {
    fail("vision failed: \(error.localizedDescription)")
}

var lines: [Line] = []
for observation in (request.results ?? []) {
    guard let best = observation.topCandidates(1).first else { continue }
    let text = best.string.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { continue }
    lines.append(Line(text: text, confidence: Double(best.confidence)))
}

let mean = lines.isEmpty ? 0 : lines.map(\.confidence).reduce(0, +) / Double(lines.count)
let out = Result(lines: lines, meanConfidence: mean)
let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]
FileHandle.standardOutput.write(try! encoder.encode(out))
