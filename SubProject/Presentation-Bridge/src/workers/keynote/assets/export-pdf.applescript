on run argv
  if (count of argv) is less than 2 then error "usage: export-pdf.applescript <input.key> <output.pdf>"
  set inputPath to item 1 of argv
  set outputPath to item 2 of argv
  set inputFile to POSIX file inputPath
  set outputFile to POSIX file outputPath

  tell application "Keynote"
    launch
    set docRef to open inputFile
    export docRef to outputFile as PDF
    close docRef saving no
  end tell

  return "ok"
end run
