' Chạy launcher không hiện cửa sổ console. Dùng: wscript launch.vbs [--target antigravity_ide]
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
args = ""
For Each a In WScript.Arguments
    args = args & " """ & a & """"
Next
shell.CurrentDirectory = root
shell.Run "pythonw.exe """ & root & "\launcher.py""" & args, 0, False
