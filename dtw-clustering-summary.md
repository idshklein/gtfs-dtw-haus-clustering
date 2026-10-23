# קיבוץ וקטורים באורכים שונים: DTW, מימוש ב-TypeScript וחישוב מקבילי

סיכום השיחה: איך מקבצים וקטורים באורכים שונים (כל איבר הוא מרחק), ואיך עושים את זה בפועל ב-TypeScript.

---

## 1. בחירת אלגוריתם

**DTW (Dynamic Time Warping)** מודד דמיון בין רצפים באורכים שונים באמצעות יישור גמיש של האיברים. מחשבים מטריצת מרחקים בין כל זוג וקטורים, ומזינים אותה לאלגוריתם קיבוץ שעובד עם מטריצת מרחקים.

### שלבי העבודה
1. **מטריצת מרחקים:** DTW לכל זוג.
2. **קיבוץ על המטריצה:**
   - **היררכי (average / complete linkage):** לא דורש k מראש, ומאפשר דנדרוגרמה.
   - **DBSCAN / HDBSCAN** עם `metric='precomputed'`: מתאים כשיש רעש ואשכולות בצפיפויות שונות.
   - **k-medoids (PAM):** נותן נציג אמיתי לכל אשכול. k-means לא מתאים כי הוא דורש ממוצע במרחב וקטורי.
   - **Spectral:** על מטריצת דמיון, כשהאשכולות לא קמורים.
3. **בחירת k:** silhouette על המטריצה המחושבת מראש.

### חלופות, לפי מה שהוקטורים מייצגים
| מצב | גישה |
|---|---|
| הסדר באיברים לא משמעותי (קבוצת מרחקים) | היסטוגרמה או סטטיסטיקות תיאוריות (ממוצע, חציון, אחוזונים, סטיית תקן) בווקטור באורך קבוע, או מרחק **Wasserstein / EMD** (`scipy.stats.wasserstein_distance`) |
| רצפים עם ריפוד | padding + masking, או embedding באמצעות autoencoder רקורנטי ואז k-means |
| מסלולים או קווים | מרחק Fréchet / Hausdorff |

**עלות:** DTW הוא O(n·m) לזוג ו-O(N²) זוגות. מקטינים אותה עם חלון Sakoe-Chiba.

---

## 2. DTW ומטריצת מרחקים (Python)

DTW מחזיר מרחק בודד בין **זוג** וקטורים. המטריצה נבנית מהרצה על כל הזוגות, והספריות עושות זאת עבורכם.

```python
# dtaidistance (מהיר, ב-C)
from dtaidistance import dtw
D = dtw.distance_matrix_fast(series)   # series = רשימת np.array (float64) באורכים שונים
# ברירת מחדל: מוחזר משולש עליון, השאר inf, צריך להשלים לסימטרית

# tslearn
from tslearn.metrics import cdist_dtw
D = cdist_dtw(series)

# fastdtw ידני
import numpy as np
from fastdtw import fastdtw
n = len(series)
D = np.zeros((n, n))
for i in range(n):
    for j in range(i + 1, n):
        D[i, j] = D[j, i] = fastdtw(series[i], series[j])[0]
```

אחר כך: `AgglomerativeClustering(metric='precomputed', linkage='average')` או `DBSCAN(metric='precomputed')`.

---

## 3. DTW ב-TypeScript

ספריות DTW ב-npm קטנות ולא תמיד מתוחזקות, ולכן עדיף לכתוב בעצמכם:

```typescript
function dtw(a: number[], b: number[], window = Infinity): number {
  const n = a.length, m = b.length;
  const w = Math.max(window, Math.abs(n - m));
  const prev = new Float64Array(m + 1).fill(Infinity);
  let cur = new Float64Array(m + 1);
  prev[0] = 0;
  let p = prev;
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity);
    for (let j = Math.max(1, i - w); j <= Math.min(m, i + w); j++) {
      const cost = Math.abs(a[i - 1] - b[j - 1]);
      cur[j] = cost + Math.min(p[j], cur[j - 1], p[j - 1]);
    }
    [p, cur] = [cur, p];
  }
  return p[m];
}
```

הפונקציה משתמשת בשתי שורות בלבד בזיכרון ותומכת בחלון Sakoe-Chiba.

### ספריות קיבוץ ב-TS
- `density-clustering`: DBSCAN, OPTICS ו-K-means. DBSCAN/OPTICS מקבלים פונקציית מרחק מותאמת (מעבירים אינדקסים כנקודות ומחזירים `D[i][j]`).
- `ml-hclust` (ml.js): היררכי. כדאי לבדוק אם הגרסה הנוכחית מקבלת מטריצת מרחקים מוכנה.
- `ml-kmeans`: לא מתאים למטריצת מרחקים.
- `hdbscanjs` ועוד: איכות ותחזוקה משתנות.

האלגוריתמים שמתאימים למטריצה מחושבת פשוטים לכתיבה עצמית: היררכי average linkage (~30 שורות), k-medoids/PAM (~40 שורות), DBSCAN על שורות המטריצה, ו-silhouette (~15 שורות).

**המלצה:** המטריצה היא החלק היקר. אותה מחשבים במקביל, ואת הקיבוץ כותבים בעצמכם או משתמשים בספרייה. ל-HDBSCAN או spectral, הדרך הפשוטה היא Python כשירות נפרד.

---

## 4. ביצועים: TypeScript מול WASM

V8 מקמפל לולאות מספריות על `Float64Array` לקוד מכונה טוב. WASM נותן בדרך כלל רק פי 1.5-3, ולכן כדאי למדוד לפני שמקמפלים.

**סדר גודל** (ליבה אחת, ללא חלון): כ-100-300 מיליון תאים בשנייה.

| N | אורך | זמן משוער (ליבה אחת) |
|---|---|---|
| 1,000 | ~100 | 5-15 שניות |
| 10,000 | ~100 | 10-30 דקות |
| 1,000 | ~1,000 | 30-90 דקות |

אלה הערכות גסות, ויש לבדוק עם benchmark על הדאטה שלכם.

**סדר עדיפות לשיפור:**
1. חלון Sakoe-Chiba (10% מהאורך מקטין את העבודה פי ~5-10 ולרוב משפר גם את איכות האשכולות).
2. Lower bounds (LB_Keogh) ו-early abandoning, שימושי בעיקר כשיש סף כמו ב-DBSCAN.
3. מקביליות (Worker Threads), כמעט לינארית.
4. WASM (Rust עם `wasm-pack` או AssemblyScript נוחים יותר מ-C עם Emscripten, ואפשר SIMD).

לדאטה גדול מאוד: `dtaidistance` ב-Python עם OpenMP.

---

## 5. זיכרון: מטריצה של 10,000 × 10,000

100 מיליון תאים:

| טיפוס | גודל |
|---|---|
| `Float64Array` | 800MB |
| `Float32Array` | 400MB |
| `Uint16Array` (קוונטיזציה) | 200MB |
| משולשית ב-Float32 | ~200MB |

- **חובה מערך שטוח**, לא `number[][]`:
  ```typescript
  const D = new Float32Array(n * n);
  D[i * n + j] = D[j * n + i] = value;
  ```
- **מטריצה משולשית:** אינדקס של (i,j) עם i<j הוא `i*n - i*(i+1)/2 + (j-i-1)`.
- **אפשר לא לאחסן בכלל:** DBSCAN/HDBSCAN מחשבים שכנים בזמן ריצה, ו-k-medoids יכול לעבוד באצוות (CLARA).
- **מחשב או שרת:** זניח (גם מחשב חלש עם 4GB+). ב-Node אין מגבלה מעשית על typed arrays.
- **דפדפן:** הקצאה אחת של 400MB עלולה להיכשל במחשבים חלשים.
- **נייד:** מערכת ההפעלה מגבילה כל אפליקציה או טאב (לעיתים ~1-2GB). 400MB על הגבול, 800MB מסוכן. עדיף לחשב בשרת.
- **צוואר הבקבוק בקיבוץ:** היררכי נאיבי הוא O(N³) ודורש עותק עבודה, כך שהמגבלה היא זמן ולא זיכרון. ל-DBSCAN ול-k-medoids אין בעיה כזו.
- שמירה לדיסק: `fs.writeFile` של ה-buffer הגולמי.

---

## 6. חישוב מקבילי (Node.js Worker Threads)

הרעיון: `SharedArrayBuffer` אחד למטריצה ואחד לנתונים (מאוחסנים שטוח עם אופסטים). כל worker כותב רק לתאים שלו, ולכן אין צורך בנעילות.

**חלוקת עבודה:** שורה i מכילה (n-i-1) זוגות, ולכן חלוקה לטווחים רציפים לא מאוזנת. משתמשים בחלוקה מעורבת (worker k לוקח שורות k, k+W, ...) או בתור משימות דינמי.

### main.ts
```typescript
import { Worker } from 'node:worker_threads';
import os from 'node:os';

const W = os.availableParallelism(); // או os.cpus().length בגרסאות ישנות
const n = series.length;

const matrix = new SharedArrayBuffer(n * n * Float32Array.BYTES_PER_ELEMENT);

const lens = Uint32Array.from(series.map(s => s.length));
const offsets = new Uint32Array(n + 1);
for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + lens[i];
const flat = new Float32Array(new SharedArrayBuffer(offsets[n] * 4));
series.forEach((s, i) => flat.set(s, offsets[i]));

const workers = Array.from({ length: W }, (_, k) =>
  new Promise<void>((resolve, reject) => {
    const w = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: { k, W, n, matrix, flat: flat.buffer, offsets, window: 10 },
    });
    w.on('message', () => resolve());
    w.on('error', reject);
  })
);
await Promise.all(workers);
const D = new Float32Array(matrix);
```

### worker.ts
```typescript
import { parentPort, workerData } from 'node:worker_threads';

const { k, W, n, matrix, flat, offsets, window } = workerData;
const D = new Float32Array(matrix);
const data = new Float32Array(flat);

function dtw(aOff: number, aLen: number, bOff: number, bLen: number, win: number): number {
  const w = Math.max(win, Math.abs(aLen - bLen));
  let prev = new Float64Array(bLen + 1).fill(Infinity);
  let cur = new Float64Array(bLen + 1);
  prev[0] = 0;
  for (let i = 1; i <= aLen; i++) {
    cur.fill(Infinity);
    const lo = Math.max(1, i - w), hi = Math.min(bLen, i + w);
    for (let j = lo; j <= hi; j++) {
      const c = Math.abs(data[aOff + i - 1] - data[bOff + j - 1]);
      cur[j] = c + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[bLen];
}

for (let i = k; i < n; i += W) {
  const aOff = offsets[i], aLen = offsets[i + 1] - aOff;
  for (let j = i + 1; j < n; j++) {
    const bOff = offsets[j], bLen = offsets[j + 1] - bOff;
    const d = dtw(aOff, aLen, bOff, bLen, window);
    D[i * n + j] = d;
    D[j * n + i] = d;
  }
}
parentPort!.postMessage('done');
```

### נקודות חשובות
- **מספר workers:** ליבות פיזיות, או `availableParallelism() - 1`.
- **האצה:** כמעט לינארית (8 ליבות ≈ פי 6-7).
- **בדפדפן:** `new Worker(...)` ו-`navigator.hardwareConcurrency`. `SharedArrayBuffer` דורש cross-origin isolation:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
- **TypeScript:** ה-worker צריך להיות JS מקומפל, או הרצה עם `tsx` / `ts-node`.
- **ספריות נוחות:** `piscina` (worker pool ל-Node), `comlink` (דפדפן).

---

## 7. כמה ליבות פנויות? (דפדפן)

הדפדפן לא יודע כמה ליבות **פנויות**, רק כמה **לוגיות** קיימות:

```typescript
const cores = navigator.hardwareConcurrency;
```

- הערך הוא threads לוגיים (עם hyper-threading פי 2 מהפיזיות), בלי מידע על עומס.
- אין API סטנדרטי לעומס CPU.
- Safari, וגם Brave/Firefox במצב anti-fingerprinting, מעגלים או מסתירים את הערך.
- בנייד הערך מטעה (big.LITTLE).

**בפועל:**
- ברירת מחדל: `Math.max(1, (navigator.hardwareConcurrency || 4) - 1)`.
- מדידה דינמית: benchmark קצר עם 1, 2, 4... workers.
- **תור משימות דינמי** עדיף על חלוקה קבועה, כי workers איטיים פשוט מבצעים פחות.
- ב-Node: `os.availableParallelism()` (מתחשב ב-cgroups) ו-`os.loadavg()` (Linux/macOS).

---

## 8. האם מסוכן לתת למשתמש לרוץ בלי להתייעץ איתו?

"מסוכן" חזק מדי. הסיכון הוא בעיקר חוויית משתמש (האטה, מאוורר, סוללה), לא נזק אמיתי.

**המלצות:**
- ברירת מחדל שמרנית (חצי מהליבות או `hardwareConcurrency - 1`).
- הרצה ב-Worker ולא ב-main thread, כדי שהדף יישאר רספונסיבי.
- progress bar וכפתור ביטול (`worker.terminate()`).
- הערכת זמן לפני הרצה: benchmark על כמה מאות זוגות, כפול N(N-1)/2.
- אישור מהמשתמש רק כשההערכה עוברת סף (דקה-שתיים) או במכשיר נייד, עם בחירה בין "מהיר" ל"עדין".

**הסיכון האמיתי הוא זיכרון:** מטריצה של 200-400MB בדפדפן חלש או בנייד עלולה לקרוס את הטאב. כדאי לבדוק מראש (`navigator.deviceMemory`, Chromium בלבד ומעוגל) ולהתריע, או לעבור לחישוב בשרת.

---

## תקציר החלטות מעשיות

1. DTW עם חלון Sakoe-Chiba (~10%) לבניית מטריצה.
2. כתיבת הליבה ב-TS והרצה ב-Worker Threads עם `SharedArrayBuffer`, בלי WASM בשלב ראשון.
3. אחסון ב-`Float32Array` שטוח (או משולשי).
4. קיבוץ: DBSCAN/HDBSCAN או k-medoids על המטריצה. היררכי נאיבי רק עד כמה אלפי איברים.
5. ב-N בעשרות אלפים או בנייד: חישוב בשרת (Python עם `dtaidistance`).
