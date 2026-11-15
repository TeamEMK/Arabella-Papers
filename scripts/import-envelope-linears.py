"""
Put the Envelope Linears designs into the app.

    python scripts/import-envelope-linears.py "C:\\Users\\user\\Downloads\\Liners\\untitled folder"
    python scripts/import-envelope-linears.py "<folder>" --confirm        # local database
    python scripts/import-envelope-linears.py "<folder>" --confirm --live # the live one

ONE FLAT FOLDER, one PDF per category:

    untitled folder/
      Artistic & abstract.pdf
      Birds_ butterflies & wildlife.pdf
      ...

There are no section folders. The section a category belongs to is already
in the database - the twenty-one categories are seeded on first boot from
the structure the office gave - so a file only has to say which CATEGORY it
is, and this works out the rest.

ONE DESIGN PER ROW, NOT ONE PDF. Each PDF is one design per page: twenty
liners in a document. Somebody looking for a liner wants to look at liners,
so the pages are pulled apart and each picture becomes its own row. The
pictures are already JPEGs inside the PDF, so they are lifted out as they
are rather than re-rendered - no second generation of compression.

WHAT GOES WHERE. Every design goes to Google Drive and the database keeps a
thumbnail for the grid: about 3MB for all three hundred, against the 69MB
the designs themselves weigh. import-catalogue.py does the opposite and
catalogue_items is 54MB of a 60MB dump, which is why a nightly backup went
from 8MB to 127MB. Once was enough.

THE NAMES ARE NOT TYPED THE SAME TWICE. The office's list says "Abstract &
Artistic" and the file says "Artistic & abstract"; the list says
"Mediterranean & Destination" and the file says "Mediterrian &
destinations". So matching is deliberately loose - word order is ignored and
a word matches its own stem or near-miss. That looseness can be wrong, so
NOTHING IS WRITTEN WITHOUT --confirm, and the whole mapping is printed first
either way. Read it before confirming it.

Re-running replaces a category's designs rather than adding a second copy.
The old Drive files are left where they are - deleting artwork because a
script was re-run is not a trade worth making.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

try:
    import pymupdf
except ImportError:  # older wheels only expose the deprecated name
    import fitz as pymupdf

import pymysql


# The grid tile is about 230 pixels wide; 280 is enough for a sharp screen at
# that size and costs about 10KB, against the ~70KB the design itself weighs.
THUMB_PX = 280
THUMB_QUALITY = 72
# The category tile's cover is the same picture, so it is simply reused.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def connect(live, db_override=None):
    """The live database only when asked for it in so many words."""
    if live:
        path = os.path.join(ROOT, '.env.backup')
        line = next(l for l in open(path, encoding='utf-8')
                    if l.startswith('LIVE_DB_URL='))
        url = line.split('=', 1)[1].strip()
        m = re.match(r'mysql://([^:]+):([^@]+)@([^:/]+):(\d+)/(.+)', url)
        user, pwd, host, port, db = m.groups()
        return pymysql.connect(host=host, port=int(port), user=user,
                               password=pwd, database=db.split('?')[0],
                               charset='utf8mb4')
    env = {}
    for raw in open(os.path.join(ROOT, '.env'), encoding='utf-8'):
        if '=' in raw and not raw.strip().startswith('#'):
            k, v = raw.split('=', 1)
            env[k.strip()] = v.strip()
    return pymysql.connect(host=env.get('DB_HOST', 'localhost'),
                           port=int(env.get('DB_PORT', 3306)),
                           user=env.get('DB_USER'), password=env.get('DB_PASSWORD'),
                           database=db_override or env.get('DB_NAME'), charset='utf8mb4')


# ── MATCHING A FILE NAME TO A CATEGORY ────────────────────────────────────
#
# These are typed by different people on different days. Everything that is
# not a letter or a digit goes, the joining words go, order is ignored, and a
# word counts as present if the other side has something close enough to it.

SKIP_WORDS = {'and', 'the', 'of'}


def words(text):
    return [w for w in re.sub(r'[^a-z0-9]+', ' ', text.lower()).split()
            if w not in SKIP_WORDS]


def near(a, b):
    """
    Two words that are the same word.

    Only by their common beginning, which is what the real differences here
    are: emboss/embossed, destinations/destination, personalisation/
    personalised, mediterrian/mediterranean. Four characters minimum and
    most of the shorter word, so floral and flooral - a genuine typo with
    three letters in common - stay apart.
    """
    if a == b:
        return True
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n >= 4 and n >= 0.6 * min(len(a), len(b))


def score(file_words, cat_words):
    """How much of the two names is the same, 0 to 1."""
    if not file_words or not cat_words:
        return 0.0
    left = list(cat_words)
    hit = 0
    for w in file_words:
        for i, c in enumerate(left):
            if near(w, c):
                hit += 1
                left.pop(i)
                break
    return hit / float(max(len(file_words), len(cat_words)))


MIN_SCORE = 0.6


def best_match(stem, categories):
    """
    The category a file names, with how sure we are and what came second.

    The runner-up is carried back because a best score that the next one is
    nearly as good as is not a match, it is a coin toss, and a coin toss is
    the thing a person should be shown rather than have decided for them.
    """
    fw = words(stem)
    ranked = sorted(
        ((score(fw, c['words']), c) for c in categories),
        key=lambda p: p[0], reverse=True)
    if not ranked:
        return None, 0.0, 0.0
    top, cat = ranked[0]
    second = ranked[1][0] if len(ranked) > 1 else 0.0
    if top < MIN_SCORE or top - second < 0.08:
        return None, top, second
    return cat, top, second


def load_categories(conn):
    with conn.cursor() as cur:
        cur.execute('SELECT id, section, category FROM envelope_linears '
                    'WHERE is_active = 1 ORDER BY section_order, sort_order')
        rows = cur.fetchall()
    return [{'id': r[0], 'section': r[1], 'category': r[2], 'words': words(r[2])}
            for r in rows]


def upload_folder(folder):
    """
    Hand a folder of pictures to the app's own Drive helper, all in one go.

    One node process for the lot rather than one per picture: there are three
    hundred of these and starting node three hundred times is five minutes of
    doing nothing. utils/drive.js already knows the folder, the credentials
    and how to share by link - a Python reimplementation would be a second
    thing to keep in step.
    """
    script = """
      const fs = require('fs'), path = require('path');
      const { uploadToDrive } = require('./utils/drive');
      (async () => {
        const dir = process.argv[1];
        const names = fs.readdirSync(dir).sort();
        const out = {};
        for (let i = 0; i < names.length; i++) {
          const n = names[i];
          out[n] = await uploadToDrive(
            fs.readFileSync(path.join(dir, n)), n, 'image/jpeg');
          if ((i + 1) % 20 === 0) console.error('  ... uploaded ' + (i + 1) + '/' + names.length);
        }
        process.stdout.write(JSON.stringify(out));
      })().catch(e => { console.error(e.message); process.exit(1); });
    """
    out = subprocess.run(['node', '-e', script, folder], cwd=ROOT, text=True,
                         stdout=subprocess.PIPE)
    if out.returncode != 0:
        raise RuntimeError('Drive upload failed')
    return json.loads(out.stdout)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('folder')
    ap.add_argument('--confirm', action='store_true',
                    help='actually upload and write; without it nothing is changed')
    ap.add_argument('--live', action='store_true', help='write to the live database')
    ap.add_argument('--db', help='a different database name, for trying it out')
    ap.add_argument('--no-upload', action='store_true',
                    help='write the rows and thumbnails but leave the Drive links empty')
    args = ap.parse_args()

    if not os.path.isdir(args.folder):
        print('Not a folder:', args.folder)
        return 1
    pdfs = sorted(f for f in os.listdir(args.folder) if f.lower().endswith('.pdf'))
    if not pdfs:
        print('No PDFs in', args.folder)
        return 1

    conn = connect(args.live, args.db)
    categories = load_categories(conn)
    if not categories:
        print('There are no categories in the database to attach these to.')
        print('They are seeded on first boot - start the app once and run this again.')
        conn.close()
        return 1

    # ── The mapping, printed before anything is touched ──
    print('Target  :', 'LIVE DATABASE' if args.live else (args.db or 'local database'))
    print('Folder  :', args.folder)
    print('Found   : %d PDFs against %d categories' % (len(pdfs), len(categories)))
    print()
    print('%-40s -> %-34s %6s %s' % ('file', 'category', 'match', 'designs'))
    print('-' * 96)

    plan = []
    unmatched = []
    taken = {}
    total_designs = 0
    for pdf in pdfs:
        stem = os.path.splitext(pdf)[0].strip()
        cat, top, second = best_match(stem, categories)
        doc = pymupdf.open(os.path.join(args.folder, pdf))
        n_pages = doc.page_count
        doc.close()
        if cat is None:
            unmatched.append((pdf, top, second))
            print('%-40s -> %-34s %5.0f%% %s'
                  % (stem[:40], '?? nothing close enough', top * 100, n_pages))
            continue
        if cat['id'] in taken:
            unmatched.append((pdf, top, second))
            print('%-40s -> %-34s %5.0f%% %s'
                  % (stem[:40], '!! already taken by ' + taken[cat['id']][:16], top * 100, n_pages))
            continue
        taken[cat['id']] = stem
        plan.append((pdf, cat, n_pages))
        total_designs += n_pages
        print('%-40s -> %-34s %5.0f%% %6d'
              % (stem[:40], cat['category'][:34], top * 100, n_pages))

    missing = [c for c in categories if c['id'] not in taken]
    print()
    print('%d PDFs matched, %d designs in them.' % (len(plan), total_designs))
    if unmatched:
        print()
        print('NOT matched (%d) - rename the file or say so and it can be mapped by hand:'
              % len(unmatched))
        for pdf, top, second in unmatched:
            print('    %-44s best %.0f%%, next %.0f%%' % (pdf[:44], top * 100, second * 100))
    if missing:
        print()
        print('Categories with no PDF (%d):' % len(missing))
        for c in missing:
            print('    %s / %s' % (c['section'], c['category']))

    if not args.confirm:
        print()
        print('Nothing was uploaded and nothing was written.')
        print('Read the mapping above, then run it again with --confirm.')
        conn.close()
        return 0

    if not plan:
        print()
        print('Nothing to do.')
        conn.close()
        return 1

    # ── Pull the pictures out ──
    print()
    print('Extracting...')
    work = tempfile.mkdtemp(prefix='envlin-')
    thumbs = {}      # drive name -> thumbnail jpeg
    # The full picture, kept to go into the row itself. The design catalogue
    # stores its pictures this way and opens them over the grid; a Drive link
    # opens a Drive page in a new tab instead, which is not what somebody
    # flicking through liners is after.
    fulls = {}       # drive name -> (mime type, bytes)
    rows = []        # (category_id, sort, drive_name, source_file, page, w, h)
    try:
        for pdf, cat, _ in plan:
            doc = pymupdf.open(os.path.join(args.folder, pdf))
            for page_no in range(doc.page_count):
                page = doc[page_no]
                images = page.get_images(full=True)
                if not images:
                    continue
                # The picture as it already is inside the PDF. Re-rendering it
                # would be a second round of JPEG on a first-generation JPEG,
                # which costs quality for nothing.
                raw = doc.extract_image(images[0][0])
                name = '%s-%03d.%s' % (
                    re.sub(r'[^A-Za-z0-9]+', '-', cat['category']).strip('-').lower(),
                    page_no + 1, raw['ext'])
                with open(os.path.join(work, name), 'wb') as fh:
                    fh.write(raw['image'])
                ext = (raw['ext'] or 'jpeg').lower()
                fulls[name] = ('image/jpeg' if ext in ('jpg', 'jpeg')
                               else 'image/' + ext, raw['image'])

                zoom = THUMB_PX / float(max(raw['width'], raw['height']) or THUMB_PX)
                pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
                thumbs[name] = pix.tobytes('jpg', jpg_quality=THUMB_QUALITY)
                rows.append((cat['id'], page_no, name, pdf, page_no + 1,
                             raw['width'], raw['height']))
            doc.close()
        print('  %d designs, %.1f MB of pictures, %.1f MB of thumbnails'
              % (len(rows),
                 sum(os.path.getsize(os.path.join(work, n)) for n in os.listdir(work)) / 1048576,
                 sum(len(t) for t in thumbs.values()) / 1048576))

        links = {}
        if not args.no_upload:
            print()
            print('Uploading to Drive (this is the slow part)...')
            links = upload_folder(work)
            print('  %d uploaded.' % len(links))
    finally:
        shutil.rmtree(work, ignore_errors=True)

    # ── Write ──
    print()
    print('Writing...')
    # ONE TRANSACTION PER CATEGORY, NOT ONE FOR ALL OF THEM.
    #
    # All three hundred designs used to go in under a single commit, which
    # is the right shape for a database on this machine and the wrong one
    # for Railway over an office line. Sixty-nine megabytes held open until
    # the last row is a transaction that only has to be unlucky once; the
    # link drops with ETIMEDOUT or ER_NET_READ_INTERRUPTED often enough to
    # measure - two tries in five on 15 November - and every image sent so
    # far is thrown away with it.
    #
    # A category at a time is twenty-one smaller bets. A drop costs the one
    # category being written, and the ones already in stay in. Re-running
    # picks up where it stopped, because a category is replaced rather than
    # added to - which was already true and is what makes this safe.
    by_cat = {}
    for row in rows:
        by_cat.setdefault(row[0], []).append(row)

    done = 0
    for _, cat, _ in plan:
        mine = by_cat.get(cat['id'], [])
        with conn.cursor() as cur:
            # A category is replaced, not added to, so a corrected PDF can
            # simply be put through again.
            cur.execute('DELETE FROM envelope_linear_items WHERE category_id = %s',
                        (cat['id'],))
            for cat_id, sort, name, src, page, w, h in mine:
                cur.execute(
                    'INSERT INTO envelope_linear_items '
                    '(category_id, source_file, source_page, file_url, width, height, '
                    ' mime_type, bytes, thumb, sort_order, is_active) '
                    'VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1)',
                    (cat_id, src, page, links.get(name, ''), w, h,
                     fulls[name][0], fulls[name][1], thumbs[name], sort))
            # The category tile shows its first design, so the cover is
            # simply that thumbnail again rather than a third size of the
            # same picture.
            cur.execute(
                'UPDATE envelope_linears SET cover = ('
                '  SELECT thumb FROM envelope_linear_items '
                '   WHERE category_id = %s AND is_active = 1 '
                '   ORDER BY sort_order, id LIMIT 1) WHERE id = %s',
                (cat['id'], cat['id']))
        conn.commit()
        done += len(mine)
        print('  %-36s %3d designs   (%d of %d)'
              % (cat['category'][:36], len(mine), done, len(rows)))

    # ── Name them ──
    # Handed to the Node side rather than worked out here. The rule for what
    # a liner is called lives in utils/linerCode.js, and a second copy of it
    # in Python is two rules that agree until the day one of them is edited.
    print()
    print('Naming...')
    # The same database this script just wrote to, said the same way. With
    # --live it must be --live: passing --db None would quietly name the
    # designs in the dev copy instead and report success.
    naming_where = ['--live'] if args.live else ['--db', args.db or '']
    naming = subprocess.run(
        ['node', os.path.join('scripts', 'code-envelope-linears.js'), '--write']
        + naming_where,
        cwd=ROOT, capture_output=True, text=True)
    for line in (naming.stdout or '').splitlines()[-3:]:
        print('  ' + line)
    if naming.returncode != 0:
        print('  Naming failed, so the designs are in but unnamed:')
        print('  ' + (naming.stderr or '').strip()[:400])
        print('  Run: node scripts/code-envelope-linears.js --write '
              + ' '.join(naming_where))

    with conn.cursor() as cur:
        cur.execute('SELECT COUNT(*) FROM envelope_linear_items WHERE is_active = 1')
        total = cur.fetchone()[0]
    conn.close()

    print('  %d designs across %d categories. %d in the table now.'
          % (len(rows), len(plan), total))
    if args.no_upload:
        print('  --no-upload was used, so no Drive links were written.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
