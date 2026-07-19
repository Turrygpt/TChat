; Чистая установка из самого установщика.
;
; Первая же страница мастера: если TChat уже установлен или от него остались
; данные, предлагаем выбор — обновиться с сохранением всего или снести данные
; и поставить начисто. Страница не показывается, когда ставят на пустое место.
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
Var TChatCleanState
Var TChatBtnKeep
Var TChatBtnClean

!macro TChatResolveDataDir
  StrCpy $TChatDataDir "$APPDATA\tchat"
  ${IfNot} ${FileExists} "$TChatDataDir\*.*"
    StrCpy $TChatDataDir "$APPDATA\TChat"
  ${EndIf}
!macroend

; Кладёт "1" в стек, если TChat уже стоит или от него остались данные.
Function TChatHasPrevious
  !insertmacro TChatResolveDataDir

  ; Программа уже стоит: в целевой папке лежит exe. APP_FILENAME определяет
  ; сам electron-builder (он же использует его в шаблоне installer.nsi),
  ; а $INSTDIR к моменту первой страницы уже подставлен в .onInit.
  ${If} ${FileExists} "$INSTDIR\${APP_FILENAME}.exe"
    Push "1"
    Return
  ${EndIf}

  ; Либо программы нет, но остались данные от прошлой версии.
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

; Нажатие любой из кнопок = переход на следующую страницу мастера,
; поэтому просто нажимаем за пользователя штатную кнопку «Далее».
!macro TChatGoNext
  GetDlgItem $R8 $HWNDPARENT 1
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 $R8
!macroend

Function TChatOnKeep
  StrCpy $TChatCleanState 0
  !insertmacro TChatGoNext
FunctionEnd

Function TChatOnClean
  ; Удаление необратимо — переспрашиваем.
  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
    "Удалить все сохранённые данные TChat?$\r$\n$\r$\nБудут стёрты история чата, токены DonationAlerts, Telegram и MAX, адреса каналов, правила алертов и стикеров.$\r$\n$\r$\nВосстановить их будет нельзя." \
    IDYES tchat_clean_yes
  Return
  tchat_clean_yes:
  StrCpy $TChatCleanState 1
  !insertmacro TChatGoNext
FunctionEnd

Function TChatWelcomePageCreate
  Call TChatHasPrevious
  Pop $R0

  ; Ставят с нуля — выбирать не из чего.
  ${If} $R0 != "1"
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $R1
  ${If} $R1 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 12u "TChat уже установлен на этом компьютере"
  Pop $R2
  CreateFont $R7 "$(^Font)" "$(^FontSize)" 700
  SendMessage $R2 ${WM_SETFONT} $R7 0

  ${NSD_CreateLabel} 0 16u 100% 20u "Выберите, что сделать с сохранёнными данными: историей чата, токенами, адресами каналов и правилами алертов."
  Pop $R3

  ${NSD_CreateButton} 0 42u 100% 16u "Обновить — сохранить все данные и настройки"
  Pop $TChatBtnKeep
  ${NSD_OnClick} $TChatBtnKeep TChatOnKeep

  ${NSD_CreateLabel} 4u 60u 96% 10u "Обычное обновление. Ничего не теряется."
  Pop $R4

  ${NSD_CreateButton} 0 76u 100% 16u "Удалить все данные и установить начисто"
  Pop $TChatBtnClean
  ${NSD_OnClick} $TChatBtnClean TChatOnClean

  ${NSD_CreateLabel} 4u 94u 96% 20u "История чата, токены и все настройки будут стёрты без возможности восстановления. После установки TChat откроет быструю настройку."
  Pop $R5

  nsDialogs::Show
FunctionEnd

Function TChatWelcomePageLeave
FunctionEnd

; Самая первая страница мастера — раньше выбора папки и установки.
!macro customWelcomePage
  Page custom TChatWelcomePageCreate TChatWelcomePageLeave
!macroend

!macro customInstall
  ${If} $TChatCleanState == 1
    !insertmacro TChatResolveDataDir
    DetailPrint "TChat: чистая установка — удаляю сохранённые данные"

    ; Вся папка данных: настройки, токены, история чата, хранилище бэкоффиса.
    RMDir /r "$TChatDataDir"
    ; Кеш смайлов и аватарок рядом с программой. Дефолтные картинки и звуки
    ; алертов не трогаем — они входят в комплект.
    RMDir /r "$INSTDIR\resources\app\assets\chat"

    DetailPrint "TChat: сохранённые данные удалены"
  ${EndIf}
!macroend

!endif ; BUILD_UNINSTALLER
