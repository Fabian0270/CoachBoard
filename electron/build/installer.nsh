; CoachBoard custom uninstall page.
; Replaces the default welcome page so the user chooses before the uninstall runs.
;
; Radio click handlers write the choice into $cb_DeleteData immediately,
; avoiding any NSD_GetState timing or handle-validity issues.
; ExpandEnvStrings is used for the AppData path so SetShellVarContext all
; never interferes.

!macro customUnWelcomePage
  Var cb_SoftRadio
  Var cb_HardRadio
  Var cb_DeleteData

  Function un.OnSoftRadioClick
    Pop $0
    StrCpy $cb_DeleteData "0"
  FunctionEnd

  Function un.OnHardRadioClick
    Pop $0
    StrCpy $cb_DeleteData "1"
  FunctionEnd

  Function un.DeleteOptionsPage
    !insertmacro MUI_HEADER_TEXT "Uninstall CoachBoard" "Choose what to remove"

    nsDialogs::Create 1018
    Pop $0

    ${NSD_CreateLabel} 0 0 100% 18u "Choose how you want to uninstall CoachBoard:"
    Pop $1

    ${NSD_CreateRadioButton} 0 24u 100% 12u "Keep my data (recommended)"
    Pop $cb_SoftRadio
    ${NSD_SetState} $cb_SoftRadio ${BST_CHECKED}
    ${NSD_OnClick} $cb_SoftRadio un.OnSoftRadioClick

    ${NSD_CreateLabel} 14u 38u 86% 26u "Removes the app but keeps your athletes, programs, and all training data. You can reinstall CoachBoard at any time and continue right where you left off."
    Pop $1

    ${NSD_CreateRadioButton} 0 70u 100% 12u "Delete everything"
    Pop $cb_HardRadio
    ${NSD_OnClick} $cb_HardRadio un.OnHardRadioClick

    ${NSD_CreateLabel} 14u 84u 86% 26u "Removes the app and permanently deletes all your data — athletes, programs, and training history. This action cannot be undone."
    Pop $1

    StrCpy $cb_DeleteData "0"

    nsDialogs::Show
  FunctionEnd

  Function un.DeleteOptionsPage_leave
    ${If} $cb_DeleteData == "1"
      ; Electron stores userData per-user under the package.json "name",
      ; i.e. %APPDATA%\coachboard-electron — NOT the product name "CoachBoard".
      ; Force per-user context so $APPDATA resolves correctly even though this
      ; is a per-machine (elevated) uninstall.
      SetShellVarContext current
      RMDir /r "$APPDATA\coachboard-electron"
      SetShellVarContext all
    ${EndIf}
  FunctionEnd

  UninstPage custom un.DeleteOptionsPage un.DeleteOptionsPage_leave
!macroend
