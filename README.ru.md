# GrokOnDeepSeekHarness (`dsh-grok-acp`, DeepSeek Harness 0.2.2-rc.1)

Запускает **Grok Build** корневым агентом сессии DeepSeek Harness (DSH) Web. Переключатель рядом с
полем ввода выбирает **DSH** (штатный агент, режим по умолчанию) или **Grok Build**. В Grok-режиме ход
ведёт Grok CLI по протоколу ACP. Его tool calls, диффы и запросы разрешений рисует родной UI DSH, а
сессия пишется в обычный лог DSH. API-ключ xAI не используется: только OAuth-логин Grok Build CLI.

> **Происхождение.** Форк [zmh2000829/DSH-agent-bridge](https://github.com/zmh2000829/DSH-agent-bridge)
> (MIT, коммит `e7111741a67269503d1f71c379902354687da7f8`, эталон поведения `dsh-grok-acp@0.3.4`),
> портированный на DSH `0.2.2-rc.1`. Исходная лицензия сохранена в [LICENSE](LICENSE).
> English version: [README.md](README.md).

## Документация

- [docs/OVERVIEW.ru.md](docs/OVERVIEW.ru.md): описание продукта за две минуты (English: [docs/OVERVIEW.md](docs/OVERVIEW.md)).
- [docs/HANDOFF.md](docs/HANDOFF.md): состояние проекта, правила и план для следующего агента (на английском).

## Требования

- DeepSeek Harness `0.2.2-rc.1` (приложение 44.7.0 или CLI `dsh` того же релиза).
- Node.js `^22.19 || >=24` для сборки.
- Grok Build CLI (проверено на 1.0.70) с выполненным OAuth-логином.

## Установка

DSH принимает бандл только при точном совпадении peer-версий `@deepseek-ai/dsh-*` с запущенным
релизом, поэтому они зафиксированы как `0.2.2-rc.1`. Исключения по версиям не используйте.

Ставьте штатной командой плагинов, **не правьте файлы профиля вручную**. Для профиля `desktop`
сначала полностью закройте приложение; лучше сперва проверить в отдельном профиле.

```powershell
git clone https://github.com/yuriyproject/GrokOnDeepSeekHarness.git
cd GrokOnDeepSeekHarness
npm ci --legacy-peer-deps
npm run check

$dsh = "C:\DS Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh test --from-default-profile web --no-open --port 6300   # после вывода URL остановить Ctrl+C
& $dsh plugin --profile test add (Get-Location).Path           # либо tarball из `npm pack`
```

Запуск с окружением Grok:

```powershell
$env:GROK_HOME    = "C:\DSProjects\grok\home-ultra"
$env:GROK_COMMAND = "C:\Users\you\.grok\bin\grok.exe"
Remove-Item Env:XAI_API_KEY -ErrorAction SilentlyContinue
& $dsh test --no-open --port 6300
```

Откройте выведенный URL, нажмите **Новая сессия** и выберите **Grok Build** под полем ввода.
Переключать движок можно только пока сессия пуста. Удаление: `dsh plugin --profile test remove dsh-grok-acp`.

## Отличия от апстрима

- Все peer-зависимости `@deepseek-ai/dsh-*` равны `0.2.2-rc.1`; `cordis` `~4.1.0`, `schemastery` `~3.19.0`.
  Пакеты `dsh-agent-presets` и `dsh-invariants` в 0.2.2 не существуют и не используются.
- Grok-пресет объявлен обычной строкой `@deepseek-ai/dsh-agent-preset` (id `grok-build`) в патче бандла и
  читается через `agentPresets` из `dsh-agent-preset-registry`. Переключатель вызывает `agentPresets.select()`.
- Строгий лог 0.2.2: каждый шаг Grok содержит assistant-сообщение, объявляющее tool calls. Обычные
  инструменты идут группой `grok_build_activity` (дочерние `tool/ptc-dispatch*`), каждая правка файла —
  корневой вызов в своём шаге (карточки диффов). `assistant/chunk` удалён: живой текст идёт через
  `agent/assistant-stream`, в сообщении хранится `stream`. Отмена записывается как `aborted`.
- Агент отдаёт `model`, ведёт собственный inbox, использует `turnBoundaryOf` и `agents.announce(agent, source)`.
- Персистентность через `sessionPersistence.open/create/read` вместо удалённых `inspect/prepare`.
- Клиент: селектор модели и `/model` через `remote.session.modelCatalog/selectModel` и проекцию
  `modelSelection`; описания команд — функции; вместо `connection.api` и `handleHostEnvelope` используются
  `ClientSessions.handleSessionAdded/Removed`; id пресета `ptc` локализован.
- Изоляция: процесс Grok получает минимальное окружение, `GROK_HOME` из конфига, без `XAI_API_KEY`,
  `shell: false`, массив аргументов и абсолютный путь. Отсутствие CLI не роняет DSH: остаётся режим DSH и
  показывается причина.
- Разрешения Grok идут в approval-UI DSH; `yoloMode` и `allowOutsideWorkspace` выключены.
- Дополнительно: значок-предупреждение, если рабочая область в облачной папке (OneDrive, Dropbox и т. п.);
  id Grok-сессии дублируется игнорируемой записью в журнале сессии DSH (запасной источник); модель и effort
  у каждой сессии свои; `steer`; картинки; опция `forwardMcp` (по умолчанию выключена, экспериментальная)
  пробрасывает MCP-серверы DSH в Grok без записи секретов в журналы.

## Безопасность

Аудит апстрима и `dsh-grok-acp@0.3.4`: [docs/UPSTREAM-SECURITY-AUDIT.md](docs/UPSTREAM-SECURITY-AUDIT.md).
Вердикт: чисто (нет install-скриптов, сетевого кода, обфускации, доступа к секретам).

## Известные ограничения

- DSH 0.2.x — предварительная версия: слоты клиента и Remote API могут меняться, а точные peer-версии
  требуют пересборки пакета под следующий релиз.
- Обычные вызовы показываются в одной группе, диффы внутри неё — текстом; правки файлов — карточками.
- Правка ждёт завершения предыдущих обычных вызовов и идёт в отдельном шаге.
- Рабочая область по умолчанию — `Documents\deepseek-harness\default-workspace`; при перенаправлении
  Документов это OneDrive. Для Grok выбирайте рабочую область вне OneDrive.
- Название плана берётся из CLI: аккаунт Ultra показывается как «SuperGrok Heavy».
