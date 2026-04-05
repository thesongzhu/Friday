# Translation Assistant

Translate text between languages with support for formality control, domain-specific terminology, and multiple translation backends.

## Usage

```
translate "Hello, how are you?" to Japanese
```

## Inputs

| Parameter | Required | Description |
|-----------|----------|-------------|
| `text` | Yes | Text to translate |
| `targetLang` | Yes | Target language (code or name) |
| `sourceLang` | No | Source language (auto-detected) |
| `formality` | No | formal, informal, or neutral |
| `domain` | No | technical, legal, medical, casual, literary, marketing |

## Supported Languages

Chinese, Japanese, Korean, English, Spanish, French, German, Italian, Portuguese, Russian, Arabic, Hindi, Thai, Vietnamese, Turkish, Dutch, Polish, Swedish, Czech, Indonesian, Malay, and more.

## Optional: DeepL Integration

For higher quality translations, set `FRIDAY_DEEPL_API_KEY` environment variable. The skill will suggest using the DeepL API via `web_fetch` when available.
