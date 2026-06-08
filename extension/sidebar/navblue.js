// NavBlue API client — all calls use the pilot's own session token

export class NavblueClient {
  constructor({ baseUrl, alc, token }) {
    this.baseUrl = baseUrl;
    this.alc = alc;
    this.token = token;
  }

  _url(params) {
    const base = `${this.baseUrl}/fcgi-bin/ClassBidUI`;
    const ts = Date.now();
    const qs = new URLSearchParams({ alc: this.alc, authmode: 'Bidder', customModifiedTime: ts, ...params });
    return `${base}?${qs}`;
  }

  async _fetch(urlParams, method = 'GET', body = null, contentType = null) {
    const url = this._url(urlParams);
    console.log('[PBS] _fetch →', method, url.replace(/alc=[^&]+/, 'alc=REDACTED').replace(/customModifiedTime=[^&]+/, 'ts=…'));
    const res = await chrome.runtime.sendMessage({
      type: 'NAVBLUE_FETCH', url, method, body, contentType
    });
    if (!res || res.error) throw new Error(res?.error || 'NavBlue fetch failed');
    if (!res.ok) {
      console.error('[PBS] NavBlue error', res.status, ':', res.body?.slice(0, 500));
      throw new Error(`NavBlue ${res.status}: ${res.body?.slice(0, 200)}`);
    }
    return res.body;
  }

  async getPersonData(period) {
    return this._fetch({ FileType: 'person', function: 'get', period, skipbidset: 'false' });
  }

  async getBidSetData(period) {
    return this._fetch({ FileType: 'bidset', function: 'get', period });
  }

  async getPairings(period) {
    // Try known FileType values until one works
    for (const ft of ['pairings', 'sched', 'schedule', 'pairing']) {
      try {
        console.log('[PBS] Trying FileType:', ft);
        const xml = await this._fetch({ FileType: ft, function: 'get', period });
        console.log('[PBS] FileType', ft, 'succeeded, length:', xml?.length);
        return xml;
      } catch (e) {
        console.warn('[PBS] FileType', ft, 'failed:', e.message);
      }
    }
    throw new Error('All FileType values failed for pairings — check Network tab in NavBlue for the correct FileType');
  }

  async getMasterData() {
    return this._fetch({ FileType: 'master', function: 'get' });
  }

  // Ensure required write attributes are present/correct on the <BidSets ...> opening tag
  _cleanBidSetsTag(tag) {
    // Set CurrentBidsModified="false"
    if (tag.includes('CurrentBidsModified')) {
      tag = tag
        .replace(/CurrentBidsModified="[^"]*"/, 'CurrentBidsModified="false"')
        .replace(/CurrentBidsModified='[^']*'/, "CurrentBidsModified='false'");
    } else {
      tag = tag.slice(0, -1) + ' CurrentBidsModified="false">';
    }
    // Add DefaultBidsModified="false" if missing — this is required by NavBlue
    if (!tag.includes('DefaultBidsModified')) {
      tag = tag.slice(0, -1) + ' DefaultBidsModified="false">';
    }
    return tag;
  }

  // target: 'current' (default, bid window must be open) | 'default' (always editable)
  async submitBid(period, bidLinesXml, target = 'current') {
    const personXml = await this.getPersonData(period);

    const dvMatch = personXml.match(/DataVersion="([^"]*)"/) ||
                    personXml.match(/DataVersion='([^']*)'/);
    if (!dvMatch) throw new Error('DataVersion not found in person data');
    const dataVersion = dvMatch[1];
    const cnMatch = personXml.match(/CategoryName="([^"]*)"/) ||
                    personXml.match(/CategoryName='([^']*)'/);
    const categoryName = cnMatch ? cnMatch[1] : '';
    console.log('[PBS] DataVersion:', dataVersion, 'Category:', categoryName, 'Target:', target);

    const bidSetsMatch = personXml.match(/<BidSets[\s\S]*?<\/BidSets>/);
    if (!bidSetsMatch) throw new Error('BidSets not found in person data');
    let bidSets = bidSetsMatch[0];

    bidSets = bidSets.replace(/^<BidSets[^>]*>/, tag => {
      if (!tag.includes('xmlns')) tag = tag.replace('<BidSets', '<BidSets xmlns="http://tempuri.org"');
      return this._cleanBidSetsTag(tag);
    });

    const innerMatch = bidLinesXml.match(/<BidLines>([\s\S]*?)<\/BidLines>/);
    const innerBidLines = innerMatch ? innerMatch[1] : '';

    const openTag  = target === 'default' ? '<DefaultBid>' : '<CurrentBid>';
    const closeTag = target === 'default' ? '</DefaultBid>' : '</CurrentBid>';
    const newBid   = `${openTag}<BidLines>${innerBidLines}</BidLines><Buddy/>${closeTag}`;

    const ciStart = bidSets.indexOf(openTag);
    if (ciStart >= 0) {
      const ciEnd = bidSets.indexOf(closeTag) + closeTag.length;
      const existing = bidSets.slice(ciStart, ciEnd);
      console.log(`[PBS] Existing ${target === 'default' ? 'DefaultBid' : 'CurrentBid'} (first 1000):`, existing.slice(0, 1000));
      const blStart = existing.indexOf('<BidLines>');
      const blEnd   = existing.indexOf('</BidLines>') + '</BidLines>'.length;
      const replaced = blStart >= 0
        ? existing.slice(0, blStart) + `<BidLines>${innerBidLines}</BidLines>` + existing.slice(blEnd)
        : newBid;
      bidSets = bidSets.slice(0, ciStart) + replaced + bidSets.slice(ciEnd);
    } else {
      // Tag doesn't exist yet — inject CurrentBid before DefaultBid, or DefaultBid before </BidSet>
      const anchor = target === 'default'
        ? bidSets.indexOf('</BidSet>')
        : (bidSets.indexOf('<DefaultBid>') >= 0 ? bidSets.indexOf('<DefaultBid>') : bidSets.indexOf('</BidSet>'));
      bidSets = bidSets.slice(0, anchor) + newBid + bidSets.slice(anchor);
    }

    const body = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${bidSets}`;
    console.log('[PBS] POST body (first 2000):', body.slice(0, 2000));

    return this._fetch(
      { FileType: 'bidset', function: 'set', period },
      'POST',
      body,
      'text/xml'
    );
  }

  // Round-trip diagnostic: POST the existing CurrentBid back unchanged
  async roundTripTest(period) {
    const personXml = await this.getPersonData(period);

    const bidSetsMatch = personXml.match(/<BidSets[\s\S]*?<\/BidSets>/);
    if (!bidSetsMatch) throw new Error('BidSets not found in person data');
    let bidSets = bidSetsMatch[0];

    // Clean opening tag
    bidSets = bidSets.replace(/^<BidSets[^>]*>/, tag => {
      if (!tag.includes('xmlns')) tag = tag.replace('<BidSets', '<BidSets xmlns="http://tempuri.org"');
      return this._cleanBidSetsTag(tag);
    });

    // If no CurrentBid exists, copy DefaultBid's BidLines into CurrentBid for the test
    if (!bidSets.includes('<CurrentBid>')) {
      const dbInnerMatch = bidSets.match(/<DefaultBid>[\s\S]*?(<BidLines>[\s\S]*?<\/BidLines>)/);
      const existingLines = dbInnerMatch ? dbInnerMatch[1] : '<BidLines></BidLines>';
      const copiedCurrentBid = `<CurrentBid>${existingLines}<Buddy/></CurrentBid>`;
      const dbStart = bidSets.indexOf('<DefaultBid>');
      const insertAt = dbStart >= 0 ? dbStart : bidSets.indexOf('</BidSet>');
      bidSets = bidSets.slice(0, insertAt) + copiedCurrentBid + bidSets.slice(insertAt);
    }

    const body = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${bidSets}`;
    console.log('[PBS] Round-trip POST body (first 800):', body.slice(0, 800));

    return this._fetch(
      { FileType: 'bidset', function: 'set', period },
      'POST',
      body,
      'text/xml'
    );
  }


  parsePersonData(xml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');

    const person = doc.querySelector('Person');
    const category = doc.querySelector('Category');

    const absences = [...doc.querySelectorAll('Absence')].map(a => ({
      code: a.getAttribute('AbsenceCode'),
      start: a.getAttribute('Start'),
      end: a.getAttribute('End'),
      historical: a.getAttribute('Historical') === 'true'
    }));

    return {
      employeeId: person?.getAttribute('EmployeeId'),
      firstName: person?.getAttribute('FirstName'),
      lastName: person?.getAttribute('LastName'),
      categoryName: category?.getAttribute('Name'),
      seniority: category?.getAttribute('Seniority'),
      categorySeniority: category?.getAttribute('CategorySeniority'),
      absences
    };
  }

  parsePairings(xml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');

    return [...doc.querySelectorAll('Pairing')].map(p => ({
      number: p.getAttribute('Number'),
      length: p.getAttribute('Length'),
      checkin: p.getAttribute('CheckIn'),
      checkout: p.getAttribute('CheckOut'),
      credit: p.getAttribute('Credit'),
      tafb: p.getAttribute('Tafb'),
      layovers: p.getAttribute('LayoverLocationNames')?.split(',').filter(Boolean) || [],
      dates: p.getAttribute('Dates'),
      detail: p.getAttribute('DetailReport') || ''
    }));
  }
}
