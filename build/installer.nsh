; Чистая установка из самого установщика.
; Если от прошлой версии остались настройки и переписка, показываем страницу
; с предложением стереть их. Страница появляется только когда есть что терять.
;
; Данные лежат в %APPDATA%\tchat — Electron берёт имя папки из поля "name"
; в package.json. Регистр на Windows не важен, но проверяем оба варианта на
; случай, если когда-нибудь появится productName верхним регистром.
;
; Весь файл спрятан за BUILD_UNINSTALLER: этот же скрипт подключается и при
; сборке деинсталлятора, где ни страниц установки, ни customInstall нет. Там
; функции и переменные остались бы неиспользованными, а NSIS ругается на это
; предупреждением, которое electron-builder приравнивает к ошибке сборки.

!ifndef BUILD_UNINSTALLER

!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"

Var TChatDataDir
Var TChatCleanCheckbox
Var TChatCleanState

!macro TChatResolveDataDir
  StrCpy $TChatDataDir "$APPDATA\tchat"
  ${IfNot} ${FileExists} "$TChatDataDir\*.*"
    StrCpy $TChatDataDir "$APPDATA\TChat"
  ${EndIf}
!macroend

; Кладёт "1" в стек, если есть настройки или переписка.
Function TChatHasData
  !insertmacro TChatResolveDataDir

  ${If} ${FileExists} "$TChatDataDir\settings\*.*"
    Push "1"
    Return
  ${EndIf}

  ${If} ${FileExists} "$TChatDataDir\chat-history\chat.jsonl"
    Push "1"
    Return
  ${EndIf}

  Push "0"
FunctionEnd

Function TChatCleanPageCreate
  Call TChatHasData
  Pop $R0

  ; Ставим поверх пустого места — страница ни к чему.
  ${If} $R0 != "1"
    Abort
  ${EndIf}

  ; MUI_HEADER_TEXT в сборке electron-builder недоступен, поэтому заголовок
  ; рисуем первой строкой самой страницы.
  nsDialogs::Create 1018
  Pop $R1
  ${If} $R1 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 12u "Найдены данные предыдущей установки TChat"
  Pop $R2
  CreateFont $R4 "$(^Font)" "$(^FontSize)" 700
  SendMessage $R2 ${WM_SETFONT} $R4 0

  ${NSD_CreateLabel} 0 16u 100% 26u "На этом компьютере уже есть токены, адреса каналов, правила алертов и стикеров, история чата.$\r$\nПо умолчанию всё сохраняется — обновление их не тронет."
  Pop $R3

  ${NSD_CreateCheckbox} 0 48u 100% 12u "Чистая установка — стереть настройки и переписку"
  Pop $TChatCleanCheckbox
  ${If} $TChatCleanState == 1
    ${NSD_Check} $TChatCleanCheckbox
  ${EndIf}

  ${NSD_CreateLabel} 13u 62u 92% 40u "Будут удалены: токены DonationAlerts, Telegram и MAX, адреса каналов, правила алертов и стикеров, история чата и кеш смайлов.$\r$\nВосстановить их будет нельзя. После установки TChat откроет быструю настройку."
  Pop $R5

  nsDialogs::Show
FunctionEnd

Function TChatCleanPageLeave
  ${NSD_GetState} $TChatCleanCheckbox $TChatCleanState
FunctionEnd

; Страницу вставляем после выбора папки установки.
!macro customPageAfterChangeDir
  Page custom TChatCleanPageCreate TChatCleanPageLeave
!macroend

!macro customInstall
  ${If} $TChatCleanState == 1
    !insertmacro TChatResolveDataDir
    DetailPrint "TChat: чистая установка — удаляю данные прошлой версии"

    ; Токены, адреса каналов, правила алертов и стикеров.
    RMDir /r "$TChatDataDir\settings"
    ; Переписка.
    RMDir /r "$TChatDataDir\chat-history"
    ; Хранилище бэкоффиса: токен DonationAlerts, client id/secret, адреса каналов.
    RMDir /r "$TChatDataDir\Local Storage"
    RMDir /r "$TChatDataDir\Session Storage"
    Delete "$TChatDataDir\updater.log"
    ; Кеш смайлов и аватарок. Дефолтные картинки и звуки алертов не трогаем.
    RMDir /r "$INSTDIR\resources\app\assets\chat"

    DetailPrint "TChat: данные прошлой версии удалены"
  ${EndIf}
!macroend

!endif ; BUILD_UNINSTALLER
