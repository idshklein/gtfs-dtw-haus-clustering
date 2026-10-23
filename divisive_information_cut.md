# חיתוך דיביזיבי של דנדוגרמה לפי אינפורמציה פנימית

חיתוך של דנדוגרמה קיימת בגבהים שונים לכל ענף, לפי כמה אינפורמציה נשארה בתוך כל צומת, ולא לפי `k` או `h` גלובליים.

## 1. הגדרות

הקלט הוא עץ היררכי על `n` פריטים (תאים, יישובים וכו') ומשתנה שני `Y` שמעליו מוגדרת האינפורמציה.

| סימון | משמעות |
|---|---|
| `p(x)` | משקל הפריט x. אחיד (1/n) או מסה אמיתית כמו מספר תצפיות |
| `p(y\|x)` | התפלגות הפריט על Y (שורה מנורמלת של מטריצת counts) |
| `p(x,y) = p(x)·p(y\|x)` | ההתפלגות המשותפת |
| `p(c) = Σ_{x∈c} p(x)` | המסה של צומת c |
| `S_c = Σ_{x∈c} p(x,·)` | וקטור באורך \|Y\|, סכום השורות של p(x,y) על חברי c |
| `E_c = Σ_{x∈c} p(x)·H(p(y\|x))` | סכום האנתרופיות של החברים, משוקלל במסה |

`p(y|x)` ו-`p(x)` הם בחירה של המשתמש, והתוצאה תלויה בהם. מטריצת מאפיינים בלי משמעות הסתברותית דורשת החלטה מפורשת על הנרמול.

## 2. פירוק האינפורמציה

לכל חלוקה של הפריטים לאשכולות C:

```
I(X;Y) = I(C;Y) + Σ_c I_in(c)
```

כאשר `I_in(c)` היא האינפורמציה שנשארת בתוך האשכול c:

```
I_in(c) = p(c) · JS_π( p(y|x) : x ∈ c ),     π_x = p(x) / p(c)
        = p(c) · H(S_c / p(c))  −  E_c
        = −Σ_y S_c(y)·log S_c(y)  +  p(c)·log p(c)  −  E_c
```

הערות:

- `I_in(c)` היא האנתרופיה של התערובת פחות הממוצע המשוקלל של אנתרופיות החברים. `H(p(y|c))` לבדה לא מספיקה: אשכול של פריטים זהים עם אנתרופיה גבוהה לא מכיל אינפורמציה פנימית.
- `I_in(c) ≥ 0`, והיא 0 בעלה ובאשכול של פריטים עם אותה התפלגות.
- `I_in` יורדת מונוטונית כלפי העלים: `I_in(c) ≥ I_in(c1) + I_in(c2)`.
- השורש מקיים `I_in(root) = I(X;Y)`.

## 3. הכלל הדיביזיבי

מפצלים את הצומת הפעיל עם `I_in` מקסימלי. הרווח מפיצול c לילדיו c1, c2 הוא:

```
gain(c) = I_in(c) − I_in(c1) − I_in(c2) = p(c) · JS_π'(p(y|c1), p(y|c2)),   π' = (p(c1), p(c2)) / p(c)
```

שני קריטריוני בחירה אפשריים, לא זהים:

| קריטריון | מה מפצלים | מתאים ל |
|---|---|---|
| `I_in(c)` (ברירת המחדל כאן) | הצומת עם הכי הרבה אינפורמציה פנימית, כולל זו שתישאר בילדים | עצירה לפי סף τ: אין אשכול עם יותר מ-τ ביטים פנימיים |
| `gain(c)` | הצומת שהפיצול שלו מוסיף הכי הרבה ל-`I(C;Y)` | מקסום `I(C;Y)` בכל צעד. זה AIB בכיוון ההפוך |

## 4. האלגוריתם

```
קלט: עץ T, מטריצת counts N, ואחד או יותר מתנאי העצירה
1. חשב p(x,y), p(x), ולכל צומת S_c ו-E_c בסריקה אחת מהעלים לשורש.
2. חשב I_in(c) לכל צומת לפי הנוסחה בסעיף 2. Ixy = I_in(root).
3. active = {root}. heap = max-heap לפי I_in. total_in = I_in(root).
4. כל עוד אין עצירה:
     c = pop(heap)
     החלף את c בילדיו c1, c2 ב-active ובערימה
     total_in += I_in(c1) + I_in(c2) − I_in(c)
5. החזר active.
```

### תנאי עצירה (כל אחד מהם, או שילוב)

| תנאי | ביטוי |
|---|---|
| מספר אשכולות | `\|active\| = k` |
| סף על אינפורמציה פנימית | `max I_in(active) ≤ τ` (בביטים) |
| אחוז אינפורמציה שנשמרה | `I(C;Y) = Ixy − total_in ≥ f · Ixy` |

התנאי השני נותן חיתוך בגבהים שונים לכל ענף. שימו לב שהגובה נמדד בביטים ומשוקלל במסה, כך שצומת קטן ולא הומוגני לא יפוצל לפני צומת גדול.

## 5. סיבוכיות

- שלב 1-2: `O(n·|Y|)` זמן, או לפי מספר הערכים השונים מאפס במטריצה דלילה.
- שלב 3-5: `O(k log k)` לחיתוך ל-k אשכולות. אין שוב מגע בנתונים.
- זיכרון: אפשר לשחרר את `S` של הילדים אחרי חישוב ההורה. בסריקה DFS שמבקרת קודם בילד הגדול, מספר הווקטורים החיים בו-זמנית הוא `O(log n)`.
- צוואר הבקבוק הוא בניית העץ ולא החיתוך. היררכיה קלאסית על מיליון תאים היא `O(n²)`, ולכן בונים עץ סקלבילי (למשל היררכיה מעל גרף kNN או מיזוג אשכולות Leiden).

## 6. מימוש ב-Python

הקוד מניח `linkage` של SciPy, שבו צומת פנימי i מקבל מזהה `n + i` וילדיו תמיד קודמים לו, ולכן מספיקה לולאה אחת בלי רקורסיה.

```python
import heapq
import numpy as np
import scipy.sparse as sp


def _xlogx(a):
    out = np.zeros_like(a, dtype=float)
    m = a > 0
    out[m] = a[m] * np.log2(a[m])
    return out


def inner_information(Z, N):
    """I_in לכל צומת (ביטים). Z = linkage, N = counts (n x |Y|, dense או sparse)."""
    n = Z.shape[0] + 1
    N = sp.csr_matrix(N, dtype=float)
    P = N / N.sum()                       # p(x,y)
    px = np.asarray(P.sum(axis=1)).ravel()

    S, E, p = {}, np.zeros(2 * n - 1), np.zeros(2 * n - 1)
    I_in = np.zeros(2 * n - 1)
    for i in range(n):                    # עלים
        row = P.getrow(i).toarray().ravel()
        S[i] = row
        p[i] = px[i]
        if px[i] > 0:
            E[i] = -(_xlogx(row / px[i]).sum()) * px[i]
        # I_in של עלה הוא 0

    for i, (a, b, _, _) in enumerate(Z[:, :4]):
        a, b, node = int(a), int(b), n + i
        S[node] = S.pop(a) + S.pop(b)     # שחרור הילדים
        p[node] = p[a] + p[b]
        E[node] = E[a] + E[b]
        s = S[node]
        I_in[node] = -_xlogx(s).sum() + p[node] * np.log2(p[node]) - E[node]
    return I_in, p


def divisive_cut(Z, I_in, k=None, tau=None, frac=None):
    n = Z.shape[0] + 1
    root = 2 * n - 2
    Ixy = I_in[root]
    heap = [(-I_in[root], root)]
    total_in = I_in[root]
    done = []                             # עלים שאי אפשר לפצל

    while heap:
        neg, c = heap[0]
        n_active = len(heap) + len(done)
        if k is not None and n_active >= k:
            break
        if tau is not None and -neg <= tau:
            break
        if frac is not None and (Ixy - total_in) >= frac * Ixy:
            break
        heapq.heappop(heap)
        if c < n:                         # עלה
            done.append(c)
            continue
        c1, c2 = int(Z[c - n, 0]), int(Z[c - n, 1])
        total_in += I_in[c1] + I_in[c2] - I_in[c]
        for ch in (c1, c2):
            heapq.heappush(heap, (-I_in[ch], ch))

    return done + [c for _, c in heap]


def labels_from_cut(Z, clusters):
    """מחזיר וקטור תוויות באורך n, בלי רקורסיה."""
    n = Z.shape[0] + 1
    labels = np.empty(n, dtype=int)
    for lab, c in enumerate(clusters):
        stack = [c]
        while stack:
            u = stack.pop()
            if u < n:
                labels[u] = lab
            else:
                stack.extend((int(Z[u - n, 0]), int(Z[u - n, 1])))
    return labels
```

דוגמת שימוש:

```python
I_in, p = inner_information(Z, counts)
clusters = divisive_cut(Z, I_in, tau=0.01)      # אין אשכול עם יותר מ-0.01 ביט פנימי
# או: divisive_cut(Z, I_in, frac=0.9)           # שימור 90% מהאינפורמציה
labels = labels_from_cut(Z, clusters)
```

## 7. נקודות לבדיקה

- בדיקת שפיות: `I_in[root]` שווה ל-`I(X;Y)` שמחושב ישירות, וסכום `I_in` על כל חיתוך ועוד `I(C;Y)` שווה ל-`I(X;Y)`.
- ערכי `I_in` שליליים קטנים הם שגיאות נומריות, ואפשר לקטום ל-0.
- עץ שנבנה בשיטה שלא קשורה ל-Y (למשל Ward על מרחב מאפיינים) לא מבטיח שפיצולים בעלי אינפורמציה גבוהה יופיעו גבוה בעץ. החיתוך הוא רק כמו העץ שמזינים אותו.
- מומלץ להשוות את שני קריטריוני הפיצול (`I_in` מול `gain`) על הנתונים עצמם.
