on run argv
  if (count of argv) is less than 2 then error "usage: convert.applescript <input.pptx> <output.key>"
  set inputPath to item 1 of argv
  set outputPath to item 2 of argv
  set inputFile to POSIX file inputPath
  set outputFile to POSIX file outputPath

  tell application "Keynote"
    launch
    set docRef to open inputFile
    set slideTotal to count of slides of docRef
    save docRef in outputFile
    close docRef saving no
  end tell

  return slideTotal as text
end run
