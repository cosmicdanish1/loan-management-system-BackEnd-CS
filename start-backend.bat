@echo off
REM =====================================================
REM Backend Server Startup Script
REM =====================================================
REM Description: Starts the NestJS backend server
REM Usage: Double-click this file or run from command line
REM =====================================================

title Loan Management - Backend Server

echo.
echo ========================================
echo   LOAN MANAGEMENT SYSTEM - BACKEND
echo ========================================
echo.

REM Change to backend directory
cd /d "%~dp0"

REM Check if node_modules exists
if not exist "node_modules\" (
    echo [INFO] node_modules not found. Installing dependencies...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] Failed to install dependencies!
        echo Please check your internet connection and try again.
        pause
        exit /b 1
    )
    echo.
    echo [SUCCESS] Dependencies installed successfully!
    echo.
)

REM Check if .env file exists
if not exist ".env" (
    echo [WARNING] .env file not found!
    echo.
    echo Creating .env from .env.example...
    copy .env.example .env
    echo.
    echo [IMPORTANT] Please update the .env file with your database credentials!
    echo Press any key to open .env file in notepad...
    pause >nul
    notepad .env
    echo.
    echo After updating .env, press any key to continue...
    pause >nul
)

echo [INFO] Starting backend server...
echo.
echo Server will start on: http://localhost:3000
echo API Documentation: http://localhost:3000/api/docs
echo.
echo Press Ctrl+C to stop the server
echo ========================================
echo.

REM Start the development server
call npm run start:dev

REM If server stops, pause to see any error messages
if errorlevel 1 (
    echo.
    echo [ERROR] Server stopped with errors!
    echo.
    pause
)
