import os
import re
import json
import base64
import sqlite3
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory, g, Response, stream_with_context
from google import genai
from google.genai import types

app = Flask(__name__, static_folder='static', template_folder='templates')

GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', '')
DB_PATH = os.path.join(os.path.dirname(__file__), 'doubtly.db')
os.makedirs(os.path.join(os.path.dirname(__file__), 'uploads'), exist_ok=True)

MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-flash-latest']

DOUBT_EVAL_PROMPT = """Is the following message a genuine academic study question for competitive exams (JEE, NEET, UPSC, boards, SAT, GRE, GMAT, etc.)?

Message: "{msg}"

Academic doubts INCLUDE: explaining science/math/history concepts, solving problems, asking about formulas, definitions, theories, exam topics, derivations, diagrams.
NOT academic doubts: greetings (hi, hello), thank-you messages, casual conversation, compliments, meta-questions about the AI app itself.

Reply ONLY with valid JSON on one line: {{"is_doubt": true}} or {{"is_doubt": false}}"""


def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(error):
    db = g.pop('db', None)
    if db is not None:
        db.close()


def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT 'New Chat',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                images TEXT DEFAULT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS vault (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id INTEGER,
                user_question TEXT NOT NULL,
                ai_response TEXT NOT NULL,
                tag TEXT DEFAULT NULL,
                personal_note TEXT DEFAULT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS user_stats (
                id INTEGER PRIMARY KEY DEFAULT 1,
                total_points INTEGER NOT NULL DEFAULT 0,
                streak INTEGER NOT NULL DEFAULT 0,
                last_date TEXT NOT NULL DEFAULT '',
                daily_doubts INTEGER NOT NULL DEFAULT 0,
                last_daily_reset TEXT NOT NULL DEFAULT ''
            );
        ''')
        # Migrations: add columns to existing tables if needed
        for tbl, col, typedef in [
            ('vault', 'tag', 'TEXT DEFAULT NULL'),
            ('vault', 'personal_note', 'TEXT DEFAULT NULL'),
            ('user_stats', 'daily_doubts', 'INTEGER DEFAULT 0'),
            ('user_stats', 'last_daily_reset', 'TEXT DEFAULT ""'),
        ]:
            try:
                conn.execute(f'ALTER TABLE {tbl} ADD COLUMN {col} {typedef}')
            except Exception:
                pass
        # Ensure the single stats row exists
        conn.execute('INSERT OR IGNORE INTO user_stats (id) VALUES (1)')
        conn.commit()


init_db()

DEEP_LEARNING_SYSTEM = """You are Doubtly AI, a Socratic Exam Tutor. Use emojis naturally to make explanations easier to read.

For every response, structure your answer EXACTLY as follows:

**The Concept**
[A brief, clear summary of the core idea in 2-3 sentences]

**The Breakdown**
[Step-by-step logical explanation with numbered steps. Be thorough and clear.]

**The Exam Hack**
[A memorable shortcut, formula, mnemonic, or pattern that works in competitive exams]

**Check Your Understanding**
[Ask ONE follow-up question to test if the student grasped the concept]

Keep your tone encouraging, clear, and student-friendly. Use real exam examples."""

COMPETITIVE_SYSTEM = """You are Doubtly AI, a Speed-Mode Exam Coach. Use emojis to make information scannable.

For every response, structure your answer EXACTLY as follows:

**The Concept**
[One-line definition only]

**The Breakdown**
[Maximum 3 bullet points — only the most exam-relevant facts]

**The Exam Hack**
[The single most important shortcut/formula/trick]

**Check Your Understanding**
[A direct MCQ-style question like they'd see in the exam]

Be extremely concise. Every word must earn its place."""


def build_parts(user_message, images):
    parts = [types.Part(text=user_message)]
    for img_data in images[:4]:
        if img_data.startswith('data:') and ',' in img_data:
            header, b64 = img_data.split(',', 1)
            mime = header.split(';')[0].split(':')[1]
            image_bytes = base64.b64decode(b64)
            parts.append(types.Part(inline_data=types.Blob(mime_type=mime, data=image_bytes)))
    return parts


def build_history(history_rows):
    result = []
    for msg in history_rows:
        role = 'user' if msg['role'] == 'user' else 'model'
        result.append(types.Content(role=role, parts=[types.Part(text=msg['content'])]))
    return result


def friendly_error(err):
    s = str(err)
    if 'RESOURCE_EXHAUSTED' in s or '429' in s:
        return ('Gemini API quota exceeded. Visit https://aistudio.google.com to check your plan '
                'or wait for the daily quota to reset.')
    if 'API_KEY_INVALID' in s or 'UNAUTHENTICATED' in s:
        return 'Invalid API key. Please check the GEMINI_API_KEY secret.'
    if '503' in s or 'UNAVAILABLE' in s:
        return 'Gemini servers are temporarily busy. Please try again in a moment.'
    return s


def classify_doubt(message):
    """Use LLM to determine if message is a genuine academic doubt. Returns True/False."""
    if not GEMINI_API_KEY:
        return False
    prompt = DOUBT_EVAL_PROMPT.format(msg=message[:300])
    try:
        client = genai.Client(api_key=GEMINI_API_KEY)
        for model_name in MODELS:
            try:
                resp = client.models.generate_content(
                    model=model_name,
                    contents=[types.Content(role='user', parts=[types.Part(text=prompt)])],
                    config=types.GenerateContentConfig(temperature=0, max_output_tokens=20)
                )
                text = (resp.text or '').strip()
                m = re.search(r'\{.*?\}', text, re.DOTALL)
                if m:
                    return bool(json.loads(m.group()).get('is_doubt', False))
            except Exception:
                continue
    except Exception:
        pass
    return False


def award_points_and_update_stats(is_doubt):
    """Award points, update daily doubts, return (points_earned, total_points, daily_doubts)."""
    points_earned = 3 if is_doubt else 0
    today = datetime.utcnow().strftime('%Y-%m-%d')
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute('SELECT * FROM user_stats WHERE id = 1').fetchone()
        stats = dict(row) if row else {}
        total_points = stats.get('total_points', 0) + points_earned
        daily_doubts = stats.get('daily_doubts', 0)
        last_reset = stats.get('last_daily_reset', '')
        # Reset daily count if it's a new day
        if last_reset != today:
            daily_doubts = 0
        daily_doubts += (1 if is_doubt else 0)
        conn.execute(
            'UPDATE user_stats SET total_points = ?, daily_doubts = ?, last_daily_reset = ? WHERE id = 1',
            (total_points, daily_doubts, today)
        )
        conn.commit()
    return points_earned, total_points, daily_doubts


@app.route('/')
def index():
    return send_from_directory('templates', 'index.html')


@app.route('/static/<path:filename>')
def static_files(filename):
    return send_from_directory('static', filename)


@app.route('/d/stats', methods=['GET'])
def get_stats():
    db = get_db()
    row = db.execute('SELECT * FROM user_stats WHERE id = 1').fetchone()
    if not row:
        return jsonify({'total_points': 0, 'streak': 0, 'daily_doubts': 0})
    return jsonify(dict(row))


@app.route('/d/stats/streak', methods=['POST'])
def update_streak():
    data = request.get_json() or {}
    streak = int(data.get('streak', 0))
    db = get_db()
    db.execute('UPDATE user_stats SET streak = ? WHERE id = 1', (streak,))
    db.commit()
    return jsonify({'success': True})


@app.route('/d/sessions', methods=['GET'])
def get_sessions():
    db = get_db()
    rows = db.execute('SELECT * FROM sessions ORDER BY updated_at DESC').fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/d/sessions', methods=['POST'])
def create_session():
    db = get_db()
    now = datetime.utcnow().isoformat()
    cur = db.execute('INSERT INTO sessions (title, created_at, updated_at) VALUES (?, ?, ?)', ('New Chat', now, now))
    db.commit()
    row = db.execute('SELECT * FROM sessions WHERE id = ?', (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route('/d/sessions/<int:sid>', methods=['DELETE'])
def delete_session(sid):
    db = get_db()
    db.execute('DELETE FROM messages WHERE session_id = ?', (sid,))
    db.execute('DELETE FROM sessions WHERE id = ?', (sid,))
    db.commit()
    return jsonify({'success': True})


@app.route('/d/sessions/<int:sid>/messages', methods=['GET'])
def get_messages(sid):
    db = get_db()
    rows = db.execute('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC', (sid,)).fetchall()
    result = []
    for r in rows:
        m = dict(r)
        if m['images']:
            m['images'] = json.loads(m['images'])
        result.append(m)
    return jsonify(result)


@app.route('/d/chat/stream', methods=['POST'])
def chat_stream():
    if not GEMINI_API_KEY:
        def err_gen():
            yield f'data: {json.dumps({"error": "No API key configured."})}\n\n'
        return Response(err_gen(), content_type='text/event-stream')

    data = request.get_json()
    session_id = data.get('session_id')
    user_message = data.get('message', '').strip()
    images = data.get('images', [])
    exam_mode = data.get('exam_mode', 'deep')

    if not session_id or not user_message:
        def err_gen():
            yield f'data: {json.dumps({"error": "Missing session_id or message"})}\n\n'
        return Response(err_gen(), content_type='text/event-stream')

    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        history_rows = conn.execute(
            'SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC', (session_id,)
        ).fetchall()
        history_list = [dict(h) for h in history_rows]

    system_prompt = DEEP_LEARNING_SYSTEM if exam_mode == 'deep' else COMPETITIVE_SYSTEM
    gemini_hist = build_history(history_list)
    parts = build_parts(user_message, images)

    def generate():
        client = genai.Client(api_key=GEMINI_API_KEY)
        full_text = []
        last_error = None
        success = False

        for model_name in MODELS:
            try:
                full_text = []
                for chunk in client.models.generate_content_stream(
                    model=model_name,
                    contents=gemini_hist + [types.Content(role='user', parts=parts)],
                    config=types.GenerateContentConfig(
                        system_instruction=system_prompt, temperature=0.7, max_output_tokens=1500)
                ):
                    if chunk.text:
                        full_text.append(chunk.text)
                        yield f'data: {json.dumps({"text": chunk.text})}\n\n'
                success = True
                break
            except Exception as e:
                last_error = e
                s = str(e)
                if '404' in s or 'NOT_FOUND' in s:
                    continue
                if '429' in s or 'RESOURCE_EXHAUSTED' in s or '503' in s:
                    continue
                break

        if not success:
            yield f'data: {json.dumps({"error": friendly_error(last_error)})}\n\n'
            return

        ai_text = ''.join(full_text)
        now = datetime.utcnow().isoformat()
        images_json = json.dumps(images) if images else None
        title_updated = False

        # Save messages
        with sqlite3.connect(DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            conn.execute(
                'INSERT INTO messages (session_id, role, content, images, created_at) VALUES (?, ?, ?, ?, ?)',
                (session_id, 'user', user_message, images_json, now)
            )
            conn.execute(
                'INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)',
                (session_id, 'assistant', ai_text, now)
            )
            if len(history_list) == 0:
                title = user_message[:50] + ('...' if len(user_message) > 50 else '')
                conn.execute('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?', (title, now, session_id))
                title_updated = True
            else:
                conn.execute('UPDATE sessions SET updated_at = ? WHERE id = ?', (now, session_id))
            conn.commit()
            session = dict(conn.execute('SELECT * FROM sessions WHERE id = ?', (session_id,)).fetchone())

        # Classify doubt and award points (post-stream, small delay acceptable)
        is_doubt = classify_doubt(user_message)
        points_earned, total_points, daily_doubts = award_points_and_update_stats(is_doubt)

        yield f'data: {json.dumps({"done": True, "session": session, "title_updated": title_updated, "full_text": ai_text, "points_earned": points_earned, "total_points": total_points, "daily_doubts": daily_doubts, "is_doubt": is_doubt})}\n\n'

    return Response(
        stream_with_context(generate()),
        content_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', 'Connection': 'keep-alive'}
    )


@app.route('/d/vault', methods=['GET'])
def get_vault():
    db = get_db()
    tag_filter = request.args.get('tag')
    if tag_filter and tag_filter != 'all':
        rows = db.execute('SELECT * FROM vault WHERE tag = ? ORDER BY created_at DESC', (tag_filter,)).fetchall()
    else:
        rows = db.execute('SELECT * FROM vault ORDER BY created_at DESC').fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/d/vault', methods=['POST'])
def save_vault():
    data = request.get_json()
    user_question = data.get('user_question', '').strip()
    ai_response = data.get('ai_response', '').strip()
    session_id = data.get('session_id')
    tag = data.get('tag', None)
    if not user_question or not ai_response:
        return jsonify({'error': 'Missing data'}), 400
    db = get_db()
    now = datetime.utcnow().isoformat()
    cur = db.execute(
        'INSERT INTO vault (session_id, user_question, ai_response, tag, created_at) VALUES (?, ?, ?, ?, ?)',
        (session_id, user_question, ai_response, tag, now)
    )
    db.commit()
    row = db.execute('SELECT * FROM vault WHERE id = ?', (cur.lastrowid,)).fetchone()
    return jsonify(dict(row)), 201


@app.route('/d/vault/<int:vid>', methods=['PATCH'])
def update_vault(vid):
    data = request.get_json()
    db = get_db()
    if 'tag' in data:
        db.execute('UPDATE vault SET tag = ? WHERE id = ?', (data['tag'], vid))
    if 'personal_note' in data:
        db.execute('UPDATE vault SET personal_note = ? WHERE id = ?', (data['personal_note'], vid))
    db.commit()
    row = db.execute('SELECT * FROM vault WHERE id = ?', (vid,)).fetchone()
    return jsonify(dict(row))


@app.route('/d/vault/<int:vid>', methods=['DELETE'])
def delete_vault(vid):
    db = get_db()
    db.execute('DELETE FROM vault WHERE id = ?', (vid,))
    db.commit()
    return jsonify({'success': True})


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
