; NSIS additions (electron-builder.yml nsis.include).
; Lists Inkslide under "Open with" for .pdf files without taking over the
; default PDF app: a ProgID plus OpenWithProgids, never the .pdf default value.
!define INKSLIDE_PROGID "Inkslide.pdf"

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\${INKSLIDE_PROGID}" "" "PDF Document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${INKSLIDE_PROGID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${INKSLIDE_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "${INKSLIDE_PROGID}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".pdf" ""
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.pdf\OpenWithProgids" "${INKSLIDE_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${INKSLIDE_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
