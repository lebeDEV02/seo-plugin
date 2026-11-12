# seo-plugin

Плагин `seo-audit` для Claude Code: еженедельный технический SEO-аудит сайта с отчётом — что поправить, где, как и на что это повлияет.

**Статус: работает HTTP-часть.** Доступность, индексация по сырому HTML, on-page, синтаксис разметки и доступность для LLM проверяются. Рендеринг в браузере, скорость, accessibility, Search Console и сравнение с прошлым запуском ещё не реализованы.

## Принцип

Работа делится на две фазы:

1. **Сбор и оценка — скрипты, без LLM.** Собирают метрики, применяют правила, сравнивают с прошлым запуском. Одинаковый вход даёт одинаковые находки.
2. **Разбор — Claude, только если есть новые или ухудшившиеся находки.** Находит причину в коде, пишет, как исправить и на что это повлияет.

Все числа в отчёте берутся из результатов скриптов. Источник, который не отработал, показывается как непокрытый, а не как «всё в порядке».

## Что будет проверяться

| Группа | Проверки |
|---|---|
| Доступность | HTTPS и сертификат, коды ответа, редиректы, `robots.txt`, sitemap |
| Открывается в браузере | Нет пустого экрана, JS-ошибок и упавших запросов |
| Рендеринг | Сырой HTML против отрендеренного, мягкие 404, ссылки без `href` |
| Индексация | canonical, meta robots, hreflang, дубли, статус в Search Console |
| On-page | title, description, h1, alt, Open Graph, битые ссылки |
| Разметка | Валидность JSON-LD, обязательные поля |
| Скорость | Core Web Vitals по реальным пользователям (CrUX) и Lighthouse |
| Accessibility | Нарушения WCAG 2.1 AA (axe-core) |
| Доступность для LLM | Политика для AI-ботов в `robots.txt`, реальный ответ ботам, контент без JS, `llms.txt` |
| Поиск | Клики, показы, CTR и позиция неделя к неделе |

Вне рамок: ключевые слова, контент-стратегия, ссылки, конкуренты, генерация текстов, автоправки.

## Установка

```bash
claude plugin marketplace add lebeDEV02/seo-plugin
```

```bash
claude plugin install seo-audit@seo-plugin
```

Скиллы: `/seo-audit:audit` и `/seo-audit:setup`.

## Запуск без Claude

Сбор и оценка — обычный скрипт на Node 20+:

```bash
cd plugins/seo-audit && npm ci
```

```bash
node plugins/seo-audit/scripts/cli.mjs run --config seo-audit.config.json
```

Минимальный конфиг — `{ "site": "https://example.com" }`; все параметры описаны в `plugins/seo-audit/templates/seo-audit.config.json` и `schema/config.schema.json`. Результат ложится в `.seo-audit/runs/<время>/`: `findings.json` с находками и `raw/` с собранными фактами.

## Разработка

Плагин можно подключить из локальной папки без публикации:

```bash
claude --plugin-dir ./plugins/seo-audit
```

Проверка манифестов:

```bash
claude plugin validate .
```

Тесты:

```bash
cd plugins/seo-audit && npm test
```

## Структура

```
.claude-plugin/marketplace.json
plugins/seo-audit/
├── .claude-plugin/plugin.json
├── skills/                 # audit, setup
├── scripts/
│   ├── cli.mjs             # run: сбор, оценка, запись результата
│   ├── collect/            # site.mjs — проверки сайта, pages.mjs — обход
│   ├── evaluate/           # каталог правил и сами правила
│   └── lib/                # http, robots, sitemap, html, config
├── rules/ai-crawlers.json  # AI-боты и их классы
├── schema/                 # схема конфига
├── templates/              # пример конфига
└── test/
```

## План

- [x] Каркас: манифесты и скиллы-заглушки
- [x] HTTP-сбор и правила: доступность, `robots.txt`, sitemap, on-page, доступность для LLM
- [ ] Chrome-сбор: рендеринг, «открывается в браузере», axe-core
- [ ] Сравнение с прошлым запуском и отчёт
- [ ] Скорость: Lighthouse и CrUX
- [ ] Search Console
- [ ] Доставка отчёта, workflow для GitHub Actions, скилл `setup`
