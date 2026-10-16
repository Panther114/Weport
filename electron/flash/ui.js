
(function () {
  'use strict'
  // The Electron preload exposes only the Flash workflow.
  var invoke = window.flash.invoke
  var listen = window.flash.listen

  var $ = function (id) { return document.getElementById(id) }
  var runBtn = $('run'), skipBox = $('skipMedia')
  var statusEl = $('status'), barWrap = $('barWrap'), bar = $('bar')
  var resultEl = $('result'), failureEl = $('failure')
  var lastOutputDir = ''

  function setStatus(text, kind) {
    statusEl.textContent = text
    statusEl.className = 'status' + (kind ? ' ' + kind : '')
  }

  function setProgress(current, total) {
    var ratio = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0
    barWrap.className = 'bar'
    bar.style.width = (ratio * 100).toFixed(1) + '%'
  }

  function setBusy(busy) {
    runBtn.disabled = busy
    runBtn.textContent = busy ? '正在导出…' : '一键提取并导出'
    skipBox.disabled = busy
    $('account').disabled = busy
    $('chooseDirectory').disabled = busy
  }

  function showFailure(message, next) {
    document.body.classList.add('done')
    failureEl.hidden = false
    resultEl.hidden = true
    $('failureMessage').textContent = message || '未知错误'
    $('failureNext').textContent = next ? '下一步：' + next : ''
    setStatus('未能完成 · 请按下面的提示处理', 'err')
    barWrap.className = 'bar idle'
    bar.style.width = '0%'
    setBusy(false)
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B'
    var units = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0, value = bytes
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
    return (i === 0 ? value : value.toFixed(1)) + ' ' + units[i]
  }

  function showResult(payload) {
    document.body.classList.add('done')
    failureEl.hidden = true
    resultEl.hidden = false
    lastOutputDir = payload.outputDir || ''
    $('resultTitle').textContent =
      '导出完成：' + payload.exportedSessions + ' 个会话 · ' + payload.files + ' 个文件'
    $('resultDir').textContent = lastOutputDir
    var seconds = (payload.elapsedMs / 1000).toFixed(1)
    $('resultTime').textContent =
      seconds + ' 秒 · 共读取 ' + payload.sessions + ' 个会话 · ' + formatBytes(payload.bytes) +
      (payload.skipMedia ? ' · 已跳过媒体' : '')
    setStatus('导出完成', 'ok')
    barWrap.className = 'bar'
    bar.style.width = '100%'
    setBusy(false)
  }

  runBtn.addEventListener('click', function () {
    document.body.classList.remove('done')
    resultEl.hidden = true
    failureEl.hidden = true
    setBusy(true)
    setProgress(0, 0)
    barWrap.className = 'bar'
    bar.style.width = '0%'
    setStatus('正在启动…')
    invoke('flash_start', { skipMedia: !!skipBox.checked, account: $('account').value }).catch(function (error) {
      showFailure(String(error), '请重新打开 WeportFlash 后再试。')
    })
  })

  $('openFolder').addEventListener('click', function () {
    if (!lastOutputDir) return
    invoke('flash_open_folder', { path: lastOutputDir }).catch(function (error) {
      setStatus(String(error), 'err')
    })
  })

  // ── engine → shell events ────────────────────────────────────────────────
  listen('flash:stage', function (event) {
    setStatus(event.payload.message)
  })

  // The key scan reports "微信未运行" / "请登录微信" etc. verbatim — never swallowed.
  listen('key:dbKeyStatus', function (event) {
    var message = event.payload && event.payload.message
    if (message) setStatus(message)
  })

  listen('flash:note', function (event) {
    var message = event.payload && event.payload.message
    if (message) setStatus(message)
  })

  // Forwarded straight from the engine's /events stream (export:progress).
  listen('export:progress', function (event) {
    var payload = event.payload || {}
    var total = Number(payload.total) || 0
    var current = Number(payload.current) || 0
    setProgress(current, total)
    var label = payload.phaseLabel || payload.currentSession || '导出中…'
    setStatus(total > 0 ? label + '（' + current + ' / ' + total + '）' : label)
  })

  listen('flash:result', function (event) { showResult(event.payload || {}) })

  listen('flash:error', function (event) {
    var payload = event.payload || {}
    showFailure(payload.message, payload.next)
  })

  listen('flash:sidecar', function (event) {
    var payload = event.payload || {}
    if (payload.status === 'failed') {
      setStatus('引擎启动失败：' + (payload.detail || ''), 'err')
    } else if (payload.status === 'restarting') {
      setStatus('引擎异常退出，正在重启…')
    }
  })

  // ── static facts ─────────────────────────────────────────────────────────
  invoke('flash_info').then(function (info) {
    $('version').textContent = 'v' + info.version
    $('footExport').textContent = info.exportRoot
    $('footData').textContent = info.dataDir
  }).catch(function () { /* the window still works; the button will report */ })
  function refreshAccounts() { return invoke('flash_accounts').then(function (accounts) {
    $('account').textContent = ''
    accounts.forEach(function (account) {
      var option = document.createElement('option')
      option.value = account.wxid
      option.textContent = account.name
      $('account').appendChild(option)
    })
  }).catch(function () { setStatus('账号检测失败，请检查微信数据目录', 'err') }) }
  $('chooseDirectory').addEventListener('click', function () {
    invoke('flash_choose_directory').then(function (result) {
      if (result.success) refreshAccounts()
      else if (result.error) setStatus(result.error, 'err')
    }).catch(function () { setStatus('数据目录选择失败', 'err') })
  })
  refreshAccounts()
})()
