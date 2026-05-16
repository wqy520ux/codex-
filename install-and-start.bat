@echo off
REM ============================================================
REM  codex-responses-adapter — 全自动安装 + 启动（Windows）
REM  王小王 著作 · 不得用于二次改编贩卖 · VX：YYYYFC0111
REM ============================================================
REM
REM  这个脚本做三件事：
REM    1. 检测 Node.js 是否已安装且版本 >= 20
REM    2. 没装就自动从官方下载 LTS MSI 并静默安装
REM    3. 安装完后立刻调用 start.bat 启动 adapter
REM
REM  双击就能跑。无需手动改任何东西。

setlocal enabledelayedexpansion

cd /d "%~dp0"
title codex-responses-adapter 安装器

echo.
echo ============================================================
echo  codex-responses-adapter 一键安装 / 启动
echo  王小王 著作  ^|  VX: YYYYFC0111
echo ============================================================
echo.

REM ---------------------------------------------------------------
REM  Step 1: 检测 Node.js
REM ---------------------------------------------------------------
echo [1/3] 检测 Node.js ...
where node >nul 2>nul
if %ERRORLEVEL% equ 0 (
  for /f "tokens=*" %%v in ('node -v 2^>nul') do set NODE_VER=%%v
  echo     已检测到 Node.js !NODE_VER!

  REM 解析主版本号判断 >= 20
  set NODE_MAJOR=!NODE_VER:~1!
  for /f "tokens=1 delims=." %%a in ("!NODE_MAJOR!") do set NODE_MAJOR=%%a
  if !NODE_MAJOR! geq 20 (
    echo     版本满足要求 ^(^>= 20^)。
    goto :STARTADAPTER
  ) else (
    echo     版本过低 ^(需要 ^>= 20^)，将自动安装新版本。
  )
) else (
  echo     未检测到 Node.js，将自动从官网下载并安装。
)

REM ---------------------------------------------------------------
REM  Step 2: 下载并静默安装 Node.js LTS
REM ---------------------------------------------------------------
echo.
echo [2/3] 下载 Node.js LTS ...

set NODE_VER_DL=20.18.1
set NODE_ARCH=x64
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set NODE_ARCH=arm64
if /i "%PROCESSOR_ARCHITECTURE%"=="x86" set NODE_ARCH=x86

set NODE_MSI=node-v%NODE_VER_DL%-%NODE_ARCH%.msi
set NODE_URL=https://nodejs.org/dist/v%NODE_VER_DL%/!NODE_MSI!
set NODE_MIRROR=https://npmmirror.com/mirrors/node/v%NODE_VER_DL%/!NODE_MSI!
set MSI_PATH=%TEMP%\!NODE_MSI!

echo     架构: %NODE_ARCH%
echo     版本: v%NODE_VER_DL%
echo     文件: !NODE_MSI!
echo.

REM 优先用国内镜像，失败 fallback 到官网
echo     [尝试镜像源 npmmirror.com] ...
powershell -NoProfile -Command "& {try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '!NODE_MIRROR!' -OutFile '!MSI_PATH!' -ErrorAction Stop; exit 0 } catch { exit 1 }}"
if %ERRORLEVEL% neq 0 (
  echo     镜像下载失败，尝试官方源 nodejs.org ...
  powershell -NoProfile -Command "& {try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -UseBasicParsing -Uri '!NODE_URL!' -OutFile '!MSI_PATH!' -ErrorAction Stop; exit 0 } catch { exit 1 }}"
  if !ERRORLEVEL! neq 0 (
    echo.
    echo [错误] 下载失败。请检查网络后重试。
    echo        或手动从 https://nodejs.org/ 下载 LTS 安装。
    echo.
    pause
    exit /b 1
  )
)
echo     下载完成: !MSI_PATH!
echo.

echo     正在静默安装 ^(需要管理员权限，可能弹 UAC^) ...
msiexec /i "!MSI_PATH!" /qn /norestart ADDLOCAL=ALL
if %ERRORLEVEL% neq 0 (
  echo.
  echo [警告] 静默安装失败，请改用图形界面安装：
  echo        !MSI_PATH!
  echo        装完后重新双击本脚本。
  echo.
  start "" "!MSI_PATH!"
  pause
  exit /b 1
)
echo     Node.js 安装完成。
echo.

REM 让本进程能立即看到新装的 node — 把默认安装路径加到 PATH
set "PATH=%ProgramFiles%\nodejs;%PATH%"

REM 清理临时安装包
del /q "!MSI_PATH!" 2>nul

REM ---------------------------------------------------------------
REM  Step 3: 启动 adapter
REM ---------------------------------------------------------------
:STARTADAPTER
echo.
echo [3/3] 启动 codex-responses-adapter ...
echo.
echo     ^(首次启动会自动 npm install，约 1-2 分钟^)
echo     ^(完成后浏览器会自动打开管理面板^)
echo.

if not exist "%~dp0start.bat" (
  echo [错误] 找不到 start.bat，请确认你解压的目录完整。
  pause
  exit /b 1
)

call "%~dp0start.bat"

endlocal
