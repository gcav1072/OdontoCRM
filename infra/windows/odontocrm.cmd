@echo off
rem =============================================================================
rem OdontoCRM - lanzador del comando del servidor (Windows)
rem
rem   odontocrm estado
rem   odontocrm respaldar
rem   odontocrm verificar
rem
rem Es un envoltorio de una linea para poder teclear `odontocrm` en una consola de
rem Administrador sin acordarse de "powershell -File ...". El guion de verdad es
rem odontocrm.ps1, que vive junto a este archivo.
rem
rem Este archivo tiene que estar en el PATH de la maquina (lo hace 10-preparar.ps1).
rem =============================================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0odontocrm.ps1" %*
