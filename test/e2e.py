# E2E-Test gegen das deployte Portal mit zwei Testkonten.
# Aufruf (Werte aus infra/secrets/.env):
#   python3 test/e2e.py "$SUPABASE_URL" "$SUPABASE_ANON_KEY" "https://<portal>" "$TEST_USER_1_EMAIL" "$TEST_USER_1_PASSWORD" "$TEST_USER_2_EMAIL" "$TEST_USER_2_PASSWORD"
# Löst zwei echte Aufrufe des Küche-Flows aus. Räumt alle results von User1 vorher und nachher weg.
import sys, json, urllib.request, urllib.error, time
SB, ANON, PORTAL, U1, P1, U2, P2 = sys.argv[1:8]
ok = fail = 0
def check(label, cond, detail=''):
    global ok, fail
    cond = bool(cond)
    ok += cond; fail += (not cond)
    print(('PASS' if cond else 'FAIL') + ': ' + label + ('' if cond else '  -> ' + str(detail)[:300]))
def req(url, method='GET', body=None, headers=None, timeout=300):
    r = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, method=method, headers={'Content-Type': 'application/json', **(headers or {})})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            t = resp.read().decode(); return resp.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode()
        try: return e.code, json.loads(t)
        except Exception: return e.code, t
def login(email, pw):
    st, d = req(f'{SB}/auth/v1/token?grant_type=password', 'POST', {'email': email, 'password': pw}, {'apikey': ANON})
    assert st == 200, f'login {email}: {st} {d}'
    return d['access_token'], d['user']['id']
def sbh(tok): return {'apikey': ANON, 'Authorization': 'Bearer ' + tok}
def ph(tok): return {'Authorization': 'Bearer ' + tok}

t1, id1 = login(U1, P1); t2, id2 = login(U2, P2)
print(f'User1={U1} ({id1[:8]}…)  User2={U2} ({id2[:8]}…)')

# Vorab-Aufräumen: alte Test-results von User1 über das Portal löschen
st, d = req(f'{SB}/rest/v1/results?select=id,owner_id', headers=sbh(t1))
for r in (d or []):
    if r['owner_id'] == id1:
        st2, _ = req(f'{PORTAL}/api/results/{r["id"]}', 'DELETE', headers=ph(t1)); print(f'   cleanup {r["id"][:8]}… → {st2}')

# 0. Ausgangslage
st, d = req(f'{SB}/rest/v1/results?select=id', headers=sbh(t1)); check('User1 sieht anfangs 0 results', st == 200 and d == [], d)
st, d = req(f'{SB}/rest/v1/rpc/portal_users', 'POST', {}, sbh(t1)); check('portal_users() liefert beide Konten', st == 200 and {x['id'] for x in d} >= {id1, id2}, d)
st, d = req(f'{PORTAL}/api/flow/kueche', 'POST', {'question': 'x'}); check('Portal-API ohne Token → 401', st == 401, d)

# 1. Küche-Flow als User1 (echter Flowise-Aufruf)
t0 = time.time()
st, d = req(f'{PORTAL}/api/flow/kueche', 'POST', {'question': 'Kurzer Test: Nenne mir drei einfache Beilagen zu gebratenem Lachs, nur als Liste.'}, ph(t1))
check(f'Flow "kueche" antwortet ({time.time()-t0:.1f}s)', st == 200 and d.get('answer'), d)
rid = d.get('resultId') if st == 200 else None
if not rid:
    print('\n=== E2E abgebrochen: Flow-Aufruf fehlgeschlagen'); sys.exit(1)
if rid:
    print('   Antwort (gekürzt):', d['answer'][:160].replace('\n', ' | '))
    r = d['result']
    check('results-Zeile: owner=User1, flow_type=kueche, 2 messages', r['owner_id'] == id1 and r['flow_type'] == 'kueche' and len(r['output_data']['messages']) == 2, r)
    print('   quickReplies:', d.get('quickReplies'))

# 2. Sichtbarkeit vor dem Share
st, d = req(f'{SB}/rest/v1/results?select=id,title', headers=sbh(t1)); check('User1 sieht 1 result', st == 200 and len(d) == 1, d)
st, d = req(f'{SB}/rest/v1/results?select=id', headers=sbh(t2)); check('User2 sieht 0 results (nicht geteilt)', st == 200 and d == [], d)
st, d = req(f'{PORTAL}/api/flow/kueche', 'POST', {'question': 'hi', 'resultId': rid}, ph(t2)); check('User2 kann fremdes result nicht fortsetzen → 404', st == 404, d)
st, d = req(f'{SB}/rest/v1/result_shares', 'POST', {'result_id': rid, 'shared_with_id': id1, 'shared_by_id': id2}, {**sbh(t2), 'Prefer': 'return=representation'})
check('User2 kann fremdes result nicht teilen (RLS)', st in (401, 403), d)

# 3. Teilen User1 → User2
st, d = req(f'{SB}/rest/v1/result_shares', 'POST', {'result_id': rid, 'shared_with_id': id2, 'shared_by_id': id1}, {**sbh(t1), 'Prefer': 'return=representation'})
check('User1 teilt mit User2', st == 201, d)
st, d = req(f'{SB}/rest/v1/result_shares?select=result_id,shared_with_id', headers=sbh(t1)); check('User1 sieht den Share', st == 200 and len(d) == 1, d)

# 4. Empfänger: lesen ja, alles andere nein
st, d = req(f'{SB}/rest/v1/results?select=id,owner_id,output_data', headers=sbh(t2))
check('User2 sieht das geteilte result', st == 200 and len(d) == 1 and d[0]['id'] == rid, d)
check('User2 sieht den vollständigen Chat (2 messages)', st == 200 and len(d) == 1 and len(d[0]['output_data']['messages']) == 2, d)
st, d = req(f'{SB}/rest/v1/result_shares?select=result_id', headers=sbh(t2)); check('User2 sieht den Share-Eintrag', st == 200 and len(d) == 1, d)
st, d = req(f'{PORTAL}/api/flow/kueche', 'POST', {'question': 'Und dazu ein Dessert?', 'resultId': rid}, ph(t2))
check('User2 darf geteilten Chat nicht fortsetzen → 403 read-only', st == 403, d)
st, d = req(f'{SB}/rest/v1/results?id=eq.{rid}', 'PATCH', {'title': 'von User2 geändert'}, {**sbh(t2), 'Prefer': 'return=representation'})
check('User2 UPDATE → 0 Zeilen', st in (200, 204) and (d == [] or d is None), (st, d))
st, d = req(f'{SB}/rest/v1/results?id=eq.{rid}', 'DELETE', headers={**sbh(t2), 'Prefer': 'return=representation'})
check('User2 DELETE → 0 Zeilen', st in (200, 204) and (d == [] or d is None), (st, d))
st, d = req(f'{PORTAL}/api/results/{rid}', 'DELETE', headers=ph(t2)); check('User2 DELETE über Portal → 403', st == 403, d)
st, d = req(f'{SB}/rest/v1/result_shares', 'POST', {'result_id': rid, 'shared_with_id': id1, 'shared_by_id': id2}, {**sbh(t2), 'Prefer': 'return=representation'})
check('User2 kann nicht weiterteilen', st in (401, 403), d)
st, d = req(f'{SB}/rest/v1/results?select=id', headers=sbh(t1)); check('User1 result unverändert vorhanden', st == 200 and len(d) == 1, d)

# 5. Owner: Folgefrage (zweiter Flowise-Aufruf) → UPDATE
t0 = time.time()
st, d = req(f'{PORTAL}/api/flow/kueche', 'POST', {'question': 'Danke. Welche der drei ist am schnellsten zubereitet? Antworte in einem Satz.', 'resultId': rid}, ph(t1))
check(f'Owner-Folgefrage ({time.time()-t0:.1f}s) → 4 messages, gleiche ID', st == 200 and d['resultId'] == rid and len(d['result']['output_data']['messages']) == 4, d)
st, d = req(f'{SB}/rest/v1/results?select=output_data&id=eq.{rid}', headers=sbh(t2))
check('User2 sieht die Folgefrage ebenfalls (4 messages)', st == 200 and len(d) == 1 and len(d[0]['output_data']['messages']) == 4, d)

# 6. Cleanup: Owner löscht → Share verschwindet
st, d = req(f'{PORTAL}/api/results/{rid}', 'DELETE', headers=ph(t1)); check('Owner löscht result über Portal', st == 200, d)
st, d = req(f'{SB}/rest/v1/results?select=id', headers=sbh(t1)); check('User1: 0 results nach Löschen', st == 200 and d == [], d)
st, d = req(f'{SB}/rest/v1/result_shares?select=result_id', headers=sbh(t2)); check('User2: Share per CASCADE weg', st == 200 and d == [], d)

print(f'\n=== E2E: {ok} PASS, {fail} FAIL')
sys.exit(1 if fail else 0)
