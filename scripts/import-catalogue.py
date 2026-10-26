"""
Turn the office's catalogue PDFs into the design gallery.

    python scripts/import-catalogue.py "C:\\Users\\user\\Desktop\\arabella"
    python scripts/import-catalogue.py "<folder>" --live      # writes to the live DB
    python scripts/import-catalogue.py "<folder>" --dry       # renders, writes nothing

Why this exists rather than an upload button: seven of the eight volumes are
over 4.5MB, which is the largest request Vercel will pass to the app at all.
They cannot be uploaded through the portal no matter what the form allows, so
they are rendered here and written straight to the database.

One row per page. Each page is a grid of designs with their codes printed
under them - AKM-056, AKM-057 - so a customer zooms a page and quotes the code
they want. Cutting every motif out separately would be the next step up and is
not needed for that.

Re-running replaces a volume's pages rather than adding a second copy, so a
corrected PDF can simply be put through again.
"""
import argparse
import io
import os
import re
import sys

try:
    import pymupdf
except ImportError:  # older wheels only expose the deprecated name
    import fitz as pymupdf

import pymysql


# 140 dpi at JPEG 82 is ~130KB a page and renders hairline flourishes cleanly;
# 141 pages come to about 18MB in all. Higher looks no better on a screen and
# costs three times the storage.
DPI = 140
JPEG_QUALITY = 82

# Which volume each file belongs to, and what to call it. Taken from the file
# names the office actually uses, so dropping a new "Arabella-Borders_Vol 2"
# into the folder needs no code change.
def classify(filename):
    stem = os.path.splitext(os.path.basename(filename))[0]
    low = stem.lower()

    if 'order' in low and 'form' in low:
        return 'Order Form', ''
    for word, category in (('border', 'Borders'), ('font', 'Fonts'),
                           ('monogram', 'Monograms'), ('motif', 'Motifs'),
                           ('pattern', 'Patterns')):
        if word in low:
            # The volume, where the name carries one: Fonts has three files and
            # "Fonts - Page 3" three times over would be unreadable.
            vol = re.search(r'vol[\s_-]*([0-9]+)', low)
            label = ''
            if vol:
                label = 'Vol ' + vol.group(1)
                if 'kpc' in low:
                    label = 'KPC ' + label
            return category, label
    return 'Motifs', stem


def connect(live, db_override=None):
    """The live database only when asked for it in so many words."""
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if live:
        path = os.path.join(root, '.env.backup')
        line = next(l for l in open(path, encoding='utf-8')
                    if l.startswith('LIVE_DB_URL='))
        url = line.split('=', 1)[1].strip()
        m = re.match(r'mysql://([^:]+):([^@]+)@([^:/]+):(\d+)/(.+)', url)
        user, pwd, host, port, db = m.groups()
        return pymysql.connect(host=host, port=int(port), user=user,
                               password=pwd, database=db.split('?')[0],
                               charset='utf8mb4')
    env = {}
    for raw in open(os.path.join(root, '.env'), encoding='utf-8'):
        if '=' in raw and not raw.strip().startswith('#'):
            k, v = raw.split('=', 1)
            env[k.strip()] = v.strip()
    return pymysql.connect(host=env.get('DB_HOST', 'localhost'),
                           port=int(env.get('DB_PORT', 3306)),
                           user=env.get('DB_USER'), password=env.get('DB_PASSWORD'),
                           database=db_override or env.get('DB_NAME'), charset='utf8mb4')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('folder')
    ap.add_argument('--live', action='store_true', help='write to the live database')
    ap.add_argument('--dry', action='store_true', help='render only, write nothing')
    ap.add_argument('--db', help='a different database name, for trying it out')
    args = ap.parse_args()

    pdfs = sorted(f for f in os.listdir(args.folder) if f.lower().endswith('.pdf'))
    if not pdfs:
        print('No PDFs in', args.folder)
        return 1

    conn = None if args.dry else connect(args.live, args.db)
    where = 'DRY RUN - nothing will be written' if args.dry else (
        'LIVE DATABASE' if args.live else (args.db or 'local database'))
    print('Target:', where)
    print()

    total_pages = 0
    total_bytes = 0
    # One counter across the whole run, not the page number. Fonts has three
    # volumes, and ordering by page would interleave them - every volume's
    # page 1 together, then every page 2. Files are walked in name order, so
    # this keeps each volume whole and its pages in sequence.
    position = 0

    for pdf in pdfs:
        path = os.path.join(args.folder, pdf)
        category, label = classify(pdf)
        doc = pymupdf.open(path)

        # A volume is replaced, not added to. Running this twice on the same
        # folder would otherwise leave every page in the gallery twice.
        if conn:
            with conn.cursor() as cur:
                cur.execute('DELETE FROM catalogue_items WHERE category = %s AND file_name LIKE %s',
                            (category, pdf + ':%'))

        pages = 0
        size = 0
        for i, page in enumerate(doc, start=1):
            pix = page.get_pixmap(dpi=DPI)
            blob = pix.tobytes('jpg', jpg_quality=JPEG_QUALITY)
            size += len(blob)
            name = ('%s · Page %d' % (label, i)) if label else ('Page %d' % i)

            if conn:
                with conn.cursor() as cur:
                    cur.execute(
                        'INSERT INTO catalogue_items '
                        '(category, name, code, file_name, mime_type, bytes, sort_order, is_active) '
                        'VALUES (%s,%s,%s,%s,%s,%s,%s,1)',
                        (category, name, '', '%s:%d' % (pdf, i), 'image/jpeg', blob, position))
            position += 1
            pages += 1

        doc.close()
        total_pages += pages
        total_bytes += size
        print('  %-38s %-11s %3d pages  %6.1f MB'
              % (pdf[:38], category, pages, size / 1048576))

    if conn:
        conn.commit()
        conn.close()

    print()
    print('%d pages, %.1f MB' % (total_pages, total_bytes / 1048576))
    if args.dry:
        print('Nothing was written.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
