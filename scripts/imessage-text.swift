import Foundation
let input = FileHandle.standardInput.readDataToEndOfFile()
do {
    let records = try JSONDecoder().decode([String].self, from: input)
    let strings = records.map { value -> String in
        guard let data = Data(base64Encoded: value) else { return "" }
        return (NSUnarchiver.unarchiveObject(with: data) as? NSAttributedString)?.string ?? ""
    }
    FileHandle.standardOutput.write(try JSONEncoder().encode(strings))
} catch {
    FileHandle.standardError.write(Data("Could not decode Messages text\n".utf8))
    exit(1)
}
