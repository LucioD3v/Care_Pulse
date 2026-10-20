# CarePulse visual assets

These images are prepared for the welcome experience:

| File | Size | Use |
| :--- | :--- | :--- |
| `carepulse-cover-apl.png` | 1920×1080 | APL welcome cover on screen devices |
| `carepulse-cover-card-large.png` | 1200×800 | Alexa app card on larger phone/tablet displays |
| `carepulse-cover-card-small.png` | 720×480 | Alexa app card on smaller displays |
| `carepulse-cover-card-master.png` | 1536×1024 | Editable 3:2 source for future exports |
| `carepulse-wellness-summary-background.png` | 1920×1080 | APL wellness-summary background |
| `carepulse-wellness-summary-background-master.png` | 1672×941 | Editable source for future exports |

Alexa downloads response images from the URL in the Lambda response. Upload the three delivery images to a public HTTPS origin such as CloudFront or an appropriately configured S3 asset origin; keeping them in this repository does not publish them.

Configure their URLs in `.env`:

```dotenv
CAREPULSE_COVER_IMAGE_URL=https://assets.example.com/carepulse-cover-apl.png
CAREPULSE_CARD_SMALL_IMAGE_URL=https://assets.example.com/carepulse-cover-card-small.png
CAREPULSE_CARD_LARGE_IMAGE_URL=https://assets.example.com/carepulse-cover-card-large.png
CAREPULSE_WELLNESS_BACKGROUND_URL=https://assets.example.com/carepulse-wellness-summary-background.png
```

Alternatively, pass `coverImageUrl`, `cardSmallImageUrl`, `cardLargeImageUrl`, and `wellnessBackgroundUrl` as Serverless parameters. If only `CAREPULSE_COVER_IMAGE_URL` is configured, the same image is used for both card sizes. Only HTTPS URLs are accepted by the application.
