import asyncio, re, sys, time, argparse
from playwright.async_api import async_playwright

EMAIL  = "1075220"
PASSWD = "Billie11!2"
BASE   = "https://qxe.pbs.vmc.navblue.cloud"
PERIOD = "JUL26"

# Final selection — all afternoon CIs except G3120 (only 2-day option available)
# 9 one-day + 1 two-day = 11 days worked, 20 days off, Jul 24-26 clear
CHERRY_PICKS = [
    "G3015",  # Jul 4   CI 13:39
    "G3027",  # Jul 7   CI 14:35
    "G3031",  # Jul 8   CI 13:39
    "G3039",  # Jul 9   CI 14:35
    "G3049",  # Jul 11  CI 13:39
    "G3068",  # Jul 15  CI 13:39
    "G3082",  # Jul 18  CI 13:39
    "G3100",  # Jul 22  CI 13:39
    "G3125",  # Jul 28-29  CI 04:07 (2-day, avoids Jul 24-27 GL block)
]


def build_bid_lines_xml(pairings):
    """Build the <BidLines> XML for a cherry-pick bid."""
    nums = "".join(f"<PairingNumber>{p}</PairingNumber>" for p in pairings)
    ln = [0]

    def line_content_first(btype, inner, sysgen=False):
        ln[0] += 1
        tail = "<SysGen></SysGen>" if sysgen else "<Editable></Editable>"
        return (
            f"    <BidLine>\n"
            f"      {inner.strip()}\n"
            f"      <BidLineNumber>{ln[0]}</BidLineNumber>\n"
            f"      <BidLineType>{btype}</BidLineType>\n"
            f"      {tail}\n"
            f"    </BidLine>"
        )

    def line_number_first(btype, inner, extra=""):
        ln[0] += 1
        ex = f"\n      {extra}" if extra else ""
        return (
            f"    <BidLine>\n"
            f"      <BidLineNumber>{ln[0]}</BidLineNumber>\n"
            f"      <BidLineType>{btype}</BidLineType>\n"
            f"      <Editable></Editable>{ex}\n"
            f"      {inner.strip()}\n"
            f"    </BidLine>"
        )

    def line_sysgen(group_type, start_inner):
        ln[0] += 1
        return (
            f"    <BidLine>\n"
            f"      <BidLineNumber>{ln[0]}</BidLineNumber>\n"
            f"      <BidLineType>StartBidGroup</BidLineType>\n"
            f"      <ShowAnalyzeDetails>false</ShowAnalyzeDetails>\n"
            f"      <StartBidGroup><BidGroupType>{group_type}</BidGroupType>{start_inner}</StartBidGroup>\n"
            f"      <SysGen></SysGen>\n"
            f"    </BidLine>"
        )

    award_catch = """<AwardPairings>
        <PairingProperties>
          <PairingProperty>
            <Award></Award>
            <PairingPropertyType>Award</PairingPropertyType>
          </PairingProperty>
        </PairingProperties>
      </AwardPairings>"""

    lines = []

    # StartBidGroup — Pairings
    lines.append(line_number_first(
        "StartBidGroup",
        "<StartBidGroup><BidGroupType>StartPairings</BidGroupType><StartPairings></StartPairings></StartBidGroup>",
        "<ShowAnalyzeDetails>false</ShowAnalyzeDetails>"
    ))

    # Cherry-pick award line
    lines.append(line_content_first("AwardPairings", f"""<AwardPairings>
        <PairingProperties>
          <PairingProperty>
            <Pairing>
              <PairingNumberType>PairingNumbers</PairingNumberType>
              <PairingNumbers>{nums}</PairingNumbers>
            </Pairing>
            <PairingPropertyType>Pairing</PairingPropertyType>
          </PairingProperty>
        </PairingProperties>
      </AwardPairings>"""))

    # Catch-all SysGen award
    lines.append(line_content_first("AwardPairings", award_catch, sysgen=True))

    # Reserve group
    lines.append(line_number_first(
        "StartBidGroup",
        "<StartBidGroup><BidGroupType>StartReserve</BidGroupType><StartReserve></StartReserve></StartBidGroup>",
        "<ShowAnalyzeDetails>false</ShowAnalyzeDetails>"
    ))

    # SysGen fallbacks required by NavBlue
    lines.append(line_sysgen("StartPairings", "<StartPairings></StartPairings>"))
    lines.append(line_content_first("AwardPairings", award_catch, sysgen=True))
    lines.append(line_sysgen("StartReserve", "<StartReserve></StartReserve>"))

    return f"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>\n<BidLines>\n" + "\n".join(lines) + "\n</BidLines>"


def clean_bidsets_tag(tag):
    """Set/add CurrentBidsModified=false and DefaultBidsModified=false."""
    if 'CurrentBidsModified' in tag:
        tag = re.sub(r'CurrentBidsModified="[^"]*"', 'CurrentBidsModified="false"', tag)
    else:
        tag = tag[:-1] + ' CurrentBidsModified="false">'
    if 'DefaultBidsModified' not in tag:
        tag = tag[:-1] + ' DefaultBidsModified="false">'
    return tag


def build_post_body(person_xml, inner_bid_lines_xml, target='current'):
    """Inject new BidLines into the person's BidSets and return the POST body.

    target: 'current' (default, bid window must be open) | 'default' (always editable)
    """
    open_tag  = '<DefaultBid>'  if target == 'default' else '<CurrentBid>'
    close_tag = '</DefaultBid>' if target == 'default' else '</CurrentBid>'

    # Extract BidSets block
    m = re.search(r'<BidSets[\s\S]*?</BidSets>', person_xml)
    if not m:
        raise ValueError("BidSets not found in person data")
    bid_sets = m.group(0)

    # Ensure xmlns on opening tag
    bid_sets = re.sub(r'^<BidSets([^>]*)>',
        lambda t: clean_bidsets_tag(
            t.group(0) if 'xmlns' in t.group(0)
            else t.group(0).replace('<BidSets', '<BidSets xmlns="http://tempuri.org"')
        ), bid_sets)

    # Extract inner content from our BidLines XML
    inner_m = re.search(r'<BidLines>([\s\S]*?)</BidLines>', inner_bid_lines_xml)
    inner = inner_m.group(1) if inner_m else ''
    new_bid = f"{open_tag}<BidLines>{inner}</BidLines><Buddy/>{close_tag}"

    tag_start = bid_sets.find(open_tag)
    if tag_start >= 0:
        tag_end = bid_sets.find(close_tag) + len(close_tag)
        existing = bid_sets[tag_start:tag_end]
        bl_start = existing.find('<BidLines>')
        bl_end = existing.find('</BidLines>') + len('</BidLines>')
        if bl_start >= 0:
            replaced = existing[:bl_start] + f"<BidLines>{inner}</BidLines>" + existing[bl_end:]
        else:
            replaced = new_bid
        bid_sets = bid_sets[:tag_start] + replaced + bid_sets[tag_end:]
    else:
        # Tag doesn't exist yet — insert CurrentBid before DefaultBid, DefaultBid before </BidSet>
        if target == 'default':
            insert_at = bid_sets.find('</BidSet>')
        else:
            db = bid_sets.find('<DefaultBid>')
            insert_at = db if db >= 0 else bid_sets.find('</BidSet>')
        bid_sets = bid_sets[:insert_at] + new_bid + bid_sets[insert_at:]

    return f'<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n{bid_sets}'


async def login(page):
    print("Navigating to NavBlue...")
    await page.goto(BASE + "/webapp/", wait_until="networkidle", timeout=30000)
    await page.wait_for_timeout(2000)

    # Try to find login field
    email_sel = None
    for sel in ['input[type="text"]', 'input[name="username"]', 'input[placeholder*="user" i]',
                'input[placeholder*="employee" i]', '#username']:
        try:
            if await page.locator(sel).count() > 0:
                email_sel = sel
                break
        except Exception:
            pass

    if not email_sel:
        await page.wait_for_timeout(3000)
        for sel in ['input[type="text"]', 'input[type="email"]', 'input[name="username"]']:
            try:
                if await page.locator(sel).count() > 0:
                    email_sel = sel
                    break
            except Exception:
                pass

    if email_sel:
        print(f"Filling login ({email_sel})...")
        await page.fill(email_sel, EMAIL)
        pwd_sel = None
        for sel in ['input[type="password"]', 'input[name="password"]', '#password']:
            try:
                if await page.locator(sel).count() > 0:
                    pwd_sel = sel
                    break
            except Exception:
                pass
        if pwd_sel:
            await page.fill(pwd_sel, PASSWD)
            submitted = False
            for btn in ['button[type="submit"]', 'button:has-text("Login")',
                        'button:has-text("Sign in")', 'button']:
                try:
                    if await page.locator(btn).count() > 0:
                        await page.locator(btn).first.click()
                        submitted = True
                        break
                except Exception:
                    pass
            if not submitted:
                await page.keyboard.press("Enter")
        await page.wait_for_timeout(5000)
    else:
        print("No login form found — may already be logged in")
        await page.wait_for_timeout(5000)

    await page.wait_for_timeout(3000)
    print("URL after login:", page.url)


async def main(submit=False, dry_run=False, target='current'):
    bid_lines_xml = build_bid_lines_xml(CHERRY_PICKS)
    print(f"Built bid XML (target: {target}):")
    print(bid_lines_xml[:600], "...")
    print(f"\nTrips: {CHERRY_PICKS}")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=False, slow_mo=200)
        page = await browser.new_page()

        await login(page)

        # Derive ALC from URL
        alc_m = re.search(r'//([^.]+)\.pbs\.vmc\.navblue', page.url)
        alc = alc_m.group(1) if alc_m else "qxe"
        print(f"ALC: {alc}")

        ts = int(time.time() * 1000)

        # Wait for app to fully initialize (JWT gets set after SSO redirect)
        print("Waiting for app to initialize and set auth tokens...")
        await page.wait_for_timeout(4000)

        # Extract JWT from localStorage
        jwt = await page.evaluate("""
            () => {
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    const v = localStorage.getItem(k);
                    if (v && v.startsWith('eyJ') && v.split('.').length === 3) return v;
                }
                return null;
            }
        """)
        print(f"JWT found: {bool(jwt)}")
        if jwt:
            print(f"JWT prefix: {jwt[:30]}...")

        # Step 1: GET person data
        print("\nFetching person data...")
        person_result = await page.evaluate(f"""
            async (jwt) => {{
                const url = '{BASE}/fcgi-bin/ClassBidUI?alc={alc}&authmode=Bidder&customModifiedTime={ts}&FileType=person&function=get&period={PERIOD}&skipbidset=false';
                const headers = {{'Accept': 'application/json, text/plain, */*', 'Cache-Control': 'no-cache'}};
                if (jwt) headers['Authorization'] = 'Bearer ' + jwt;
                const r = await fetch(url, {{credentials:'include', headers}});
                return {{ok: r.ok, status: r.status, body: await r.text()}};
            }}
        """, jwt)

        if not person_result['ok']:
            print(f"ERROR: person data returned {person_result['status']}")
            print(person_result['body'][:500])
            await browser.close()
            return

        person_xml = person_result['body']
        print(f"Person data: {len(person_xml)} bytes")

        # Verify DataVersion
        dv_m = re.search(r'DataVersion="([^"]*)"', person_xml)
        if not dv_m:
            print("ERROR: DataVersion not found")
            print(person_xml[:500])
            await browser.close()
            return
        print(f"DataVersion: {dv_m.group(1)}")

        # Save person data for inspection
        with open("person_data_pre_submit.xml", "w", encoding="utf-8") as f:
            f.write(person_xml)
        print("Saved person_data_pre_submit.xml")

        # Step 2: Build POST body
        print(f"\nBuilding bid POST body (target: {target})...")
        try:
            post_body = build_post_body(person_xml, bid_lines_xml, target)
        except Exception as e:
            print(f"ERROR building bid: {e}")
            await browser.close()
            return

        print(f"POST body: {len(post_body)} bytes")
        with open("bid_post_body.xml", "w", encoding="utf-8") as f:
            f.write(post_body)
        print("Saved bid_post_body.xml — review before submission")

        # Show the target bid section that will be submitted
        open_tag  = '<DefaultBid>'  if target == 'default' else '<CurrentBid>'
        close_tag = '</DefaultBid>' if target == 'default' else '</CurrentBid>'
        ci_start = post_body.find(open_tag)
        ci_end = post_body.find(close_tag) + len(close_tag) if ci_start >= 0 else -1
        if ci_start >= 0:
            print(f"\n{'Default' if target == 'default' else 'Current'}Bid to be submitted:")
            print(post_body[ci_start:ci_end][:2000])

        print("\n" + "="*60)
        print("READY TO SUBMIT")
        print(f"Trips: {', '.join(CHERRY_PICKS)}")
        print("10 days worked, 21 days off, Jul 24-27 clear")
        print("="*60)

        if dry_run or not submit:
            print("\n[DRY RUN] Pass --submit to actually submit.")
            await browser.close()
            return

        # Step 3: POST the bid — pass body as argument to avoid JS template escaping issues
        ts2 = int(time.time() * 1000)
        post_url = f"{BASE}/fcgi-bin/ClassBidUI?alc={alc}&authmode=Bidder&customModifiedTime={ts2}&FileType=bidset&function=set&period={PERIOD}"
        print(f"\nPOSTing to: {post_url}")

        submit_result = await page.evaluate("""
            async ([url, body, jwt]) => {
                const headers = {
                    'Content-Type': 'text/xml',
                    'Accept': 'application/json, text/plain, */*',
                    'Cache-Control': 'no-cache',
                };
                if (jwt) headers['Authorization'] = 'Bearer ' + jwt;
                const r = await fetch(url, {
                    method: 'POST',
                    headers,
                    credentials: 'include',
                    body: body
                });
                return {ok: r.ok, status: r.status, body: await r.text()};
            }
        """, [post_url, post_body, jwt])

        print(f"\nSubmit response: HTTP {submit_result['status']}")
        print(f"Response body ({len(submit_result['body'])} bytes):")
        print(submit_result['body'][:1000])

        with open("submit_response.xml", "w", encoding="utf-8") as f:
            f.write(submit_result['body'])
        print("\nSaved submit_response.xml")

        if submit_result['ok']:
            print("\n✓ BID SUBMITTED SUCCESSFULLY")
        else:
            print("\n✗ SUBMISSION FAILED")

        await browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--submit', action='store_true', help='Actually submit (omit for dry-run)')
    parser.add_argument('--dry-run', action='store_true', help='Stop after building POST body, do not submit')
    parser.add_argument('--target', choices=['current', 'default'], default='current',
                        help='Bid target: current (window must be open) or default (always editable)')
    args_cli = parser.parse_args()
    asyncio.run(main(submit=args_cli.submit, dry_run=args_cli.dry_run, target=args_cli.target))
