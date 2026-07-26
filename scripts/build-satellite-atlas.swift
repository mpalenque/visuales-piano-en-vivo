#!/usr/bin/env swift

import AppKit
import CoreImage
import Foundation

struct SatelliteSource {
  let filename: String
}

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
  FileHandle.standardError.write(
    Data("Uso: swift scripts/build-satellite-atlas.swift <directorio-fuentes> <atlas.jpg>\n".utf8)
  )
  exit(64)
}

let sourceDirectory = URL(fileURLWithPath: arguments[1], isDirectory: true)
let outputURL = URL(fileURLWithPath: arguments[2])
let sources = [
  SatelliteSource(filename: "olympic-summer.jpg"),
  SatelliteSource(filename: "borneo.jpg"),
  SatelliteSource(filename: "peru-tamshiyacu.jpg"),
  SatelliteSource(filename: "bolivia.jpg"),
  SatelliteSource(filename: "smoky-fall.jpg"),
  SatelliteSource(filename: "smoky-summer.jpg"),
  SatelliteSource(filename: "yellowstone.jpg"),
  SatelliteSource(filename: "madagascar.jpg"),
]

let cropCentres: [(CGFloat, CGFloat)] = [
  (0.30, 0.28),
  (0.50, 0.27),
  (0.70, 0.30),
  (0.31, 0.50),
  (0.52, 0.50),
  (0.69, 0.52),
  (0.34, 0.70),
  (0.64, 0.70),
]
let cropScales: [CGFloat] = [0.28, 0.33, 0.30, 0.35, 0.29, 0.32, 0.34, 0.30]
let tileSize = 512
let gridSize = 8
let atlasSize = tileSize * gridSize

guard
  let colourSpace = CGColorSpace(name: CGColorSpace.sRGB),
  let context = CGContext(
    data: nil,
    width: atlasSize,
    height: atlasSize,
    bitsPerComponent: 8,
    bytesPerRow: atlasSize * 4,
    space: colourSpace,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
  )
else {
  fatalError("No se pudo crear el contexto gráfico del atlas.")
}

let coreImageContext = CIContext(options: [.cacheIntermediates: false])
let sourceImages: [CGImage] = sources.map { source in
  let url = sourceDirectory.appendingPathComponent(source.filename)
  guard let image = NSImage(contentsOf: url) else {
    fatalError("Falta la fuente \(source.filename) en \(sourceDirectory.path).")
  }
  var proposedRect = NSRect(origin: .zero, size: image.size)
  guard let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
    fatalError("No se pudo decodificar \(source.filename).")
  }
  return cgImage
}

context.interpolationQuality = CGInterpolationQuality.high
context.setFillColor(NSColor.black.cgColor)
context.fill(CGRect(x: 0, y: 0, width: atlasSize, height: atlasSize))

func averageLuminance(of image: CIImage) -> CGFloat {
  let average = image.applyingFilter(
    "CIAreaAverage",
    parameters: [kCIInputExtentKey: CIVector(cgRect: image.extent)]
  )
  var pixel = [UInt8](repeating: 0, count: 4)
  pixel.withUnsafeMutableBytes { bytes in
    guard let baseAddress = bytes.baseAddress else {
      return
    }
    coreImageContext.render(
      average,
      toBitmap: baseAddress,
      rowBytes: 4,
      bounds: CGRect(x: 0, y: 0, width: 1, height: 1),
      format: CIFormat.RGBA8,
      colorSpace: colourSpace
    )
  }
  let red = 0.2126 * CGFloat(pixel[0])
  let green = 0.7152 * CGFloat(pixel[1])
  let blue = 0.0722 * CGFloat(pixel[2])
  return max(0.02, (red + green + blue) / 255)
}

func makeTile(from sourceImage: CGImage, tileIndex: Int, sourceIndex: Int) -> CGImage {
  let sourceWidth = CGFloat(sourceImage.width)
  let sourceHeight = CGFloat(sourceImage.height)
  let shortestSide = min(sourceWidth, sourceHeight)
  let variation = (tileIndex / sources.count + sourceIndex * 3) % cropCentres.count
  let centre = cropCentres[variation]
  let scaleIndex = (variation + tileIndex) % cropScales.count
  let cropSide = floor(shortestSide * cropScales[scaleIndex])
  let proposedX = centre.0 * sourceWidth - cropSide / 2
  let proposedY = centre.1 * sourceHeight - cropSide / 2
  let cropX = max(0, min(sourceWidth - cropSide, proposedX))
  let cropY = max(0, min(sourceHeight - cropSide, proposedY))
  let cropRect = CGRect(x: cropX, y: cropY, width: cropSide, height: cropSide).integral

  guard let crop = sourceImage.cropping(to: cropRect) else {
    fatalError("No se pudo recortar la celda \(tileIndex).")
  }

  let input = CIImage(cgImage: crop)
  let luminance = averageLuminance(of: input)
  let exposure = max(-0.45, min(1.35, log2(0.30 / luminance)))
  let exposed = input.applyingFilter(
    "CIExposureAdjust",
    parameters: [kCIInputEVKey: exposure]
  )
  let coloured = exposed.applyingFilter(
    "CIColorControls",
    parameters: [
      kCIInputSaturationKey: 1.16,
      kCIInputContrastKey: 1.08,
      kCIInputBrightnessKey: -0.015,
    ]
  )
  let sharpened = coloured.applyingFilter(
    "CISharpenLuminance",
    parameters: [kCIInputSharpnessKey: 0.28]
  )

  guard let result = coreImageContext.createCGImage(sharpened, from: sharpened.extent) else {
    fatalError("No se pudo procesar la celda \(tileIndex).")
  }
  return result
}

for tileIndex in 0..<(gridSize * gridSize) {
  autoreleasepool {
    // The prime-number stride avoids visually grouping regions from the same scene.
    let sourceIndex = (tileIndex * 5 + tileIndex / sources.count) % sources.count
    let sourceImage = sourceImages[sourceIndex]
    let gradedImage = makeTile(
      from: sourceImage,
      tileIndex: tileIndex,
      sourceIndex: sourceIndex
    )

    let column = tileIndex % gridSize
    let row = tileIndex / gridSize
    let destination = CGRect(
      x: column * tileSize,
      y: (gridSize - 1 - row) * tileSize,
      width: tileSize,
      height: tileSize
    )
    context.draw(gradedImage, in: destination)
  }
}

guard let atlasImage = context.makeImage() else {
  fatalError("No se pudo finalizar la imagen del atlas.")
}
let bitmap = NSBitmapImageRep(cgImage: atlasImage)
guard let jpeg = bitmap.representation(
  using: NSBitmapImageRep.FileType.jpeg,
  properties: [NSBitmapImageRep.PropertyKey.compressionFactor: 0.94]
) else {
  fatalError("No se pudo codificar el atlas JPEG.")
}

try FileManager.default.createDirectory(
  at: outputURL.deletingLastPathComponent(),
  withIntermediateDirectories: true
)
try jpeg.write(to: outputURL, options: Data.WritingOptions.atomic)
print("Atlas satelital generado: \(outputURL.path) (\(atlasSize)x\(atlasSize), 64 vistas)")
