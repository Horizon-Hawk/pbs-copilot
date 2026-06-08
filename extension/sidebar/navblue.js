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
    return this._fetch({ FileType: 'pairings', function: 'get', period });
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

  async submitBid(period, bidLinesXml) {
    const personXml = await this.getPersonData(period);

    // Extract DataVersion for logging
    const dvMatch = personXml.match(/DataVersion="([^"]*)"/) ||
                    personXml.match(/DataVersion='([^']*)'/);
    if (!dvMatch) throw new Error('DataVersion not found in person data');
    const dataVersion = dvMatch[1];
    const cnMatch = personXml.match(/CategoryName="([^"]*)"/) ||
                    personXml.match(/CategoryName='([^']*)'/);
    const categoryName = cnMatch ? cnMatch[1] : '';
    console.log('[PBS] DataVersion:', dataVersion, 'Category:', categoryName);

    // Extract BidSets block verbatim, then clean read-only attributes
    const bidSetsMatch = personXml.match(/<BidSets[\s\S]*?<\/BidSets>/);
    if (!bidSetsMatch) throw new Error('BidSets not found in person data');
    let bidSets = bidSetsMatch[0];

    // Clean the opening tag
    bidSets = bidSets.replace(/^<BidSets[^>]*>/, tag => {
      if (!tag.includes('xmlns')) tag = tag.replace('<BidSets', '<BidSets xmlns="http://tempuri.org"');
      return this._cleanBidSetsTag(tag);
    });

    // Extract our new BidLines content
    const innerMatch = bidLinesXml.match(/<BidLines>([\s\S]*?)<\/BidLines>/);
    const innerBidLines = innerMatch ? innerMatch[1] : '';
    const newCurrentBid = `<CurrentBid><BidLines>${innerBidLines}</BidLines><Buddy/></CurrentBid>`;

    // Replace or inject CurrentBid
    const ciStart = bidSets.indexOf('<CurrentBid>');
    if (ciStart >= 0) {
      const ciEnd = bidSets.indexOf('</CurrentBid>') + '</CurrentBid>'.length;
      const existing = bidSets.slice(ciStart, ciEnd);
      console.log('[PBS] Existing CurrentBid (first 1000):', existing.slice(0, 1000));

      // Only swap out <BidLines> — preserve Buddy and any other elements NavBlue may require
      const blStart = existing.indexOf('<BidLines>');
      const blEnd = existing.indexOf('</BidLines>') + '</BidLines>'.length;
      const replaced = blStart >= 0
        ? existing.slice(0, blStart) + `<BidLines>${innerBidLines}</BidLines>` + existing.slice(blEnd)
        : `<CurrentBid><BidLines>${innerBidLines}</BidLines><Buddy/></CurrentBid>`;
      bidSets = bidSets.slice(0, ciStart) + replaced + bidSets.slice(ciEnd);
      const nc = bidSets.indexOf('<CurrentBid>');
      const ne = bidSets.indexOf('</CurrentBid>') + '</CurrentBid>'.length;
      console.log('[PBS] New CurrentBid (first 3000):', bidSets.slice(nc, ne).slice(0, 3000));
    } else {
      // No CurrentBid in personXml — inject before DefaultBid (or before </BidSet>)
      const dbStart = bidSets.indexOf('<DefaultBid>');
      const insertAt = dbStart >= 0 ? dbStart : bidSets.indexOf('</BidSet>');
      bidSets = bidSets.slice(0, insertAt) + newCurrentBid + bidSets.slice(insertAt);
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
