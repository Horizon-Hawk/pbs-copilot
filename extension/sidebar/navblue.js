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

  _headers() {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/json, text/plain, */*',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    };
  }

  async getPersonData(period) {
    const url = this._url({ FileType: 'person', function: 'get', period, skipbidset: 'false' });
    const res = await fetch(url, { headers: this._headers() });
    if (!res.ok) throw new Error(`NavBlue person fetch failed: ${res.status}`);
    return res.text(); // returns XML
  }

  async getPairings(period) {
    const url = this._url({ FileType: 'pairings', function: 'get', period });
    const res = await fetch(url, { headers: this._headers() });
    if (!res.ok) throw new Error(`NavBlue pairings fetch failed: ${res.status}`);
    return res.text();
  }

  async getMasterData() {
    const url = this._url({ FileType: 'master', function: 'get' });
    const res = await fetch(url, { headers: this._headers() });
    if (!res.ok) throw new Error(`NavBlue master fetch failed: ${res.status}`);
    return res.text();
  }

  async submitBid(period, bidXml) {
    const url = this._url({ FileType: 'person', function: 'set', period });
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...this._headers(), 'Content-Type': 'text/xml;charset=UTF-8' },
      body: bidXml
    });
    if (!res.ok) throw new Error(`NavBlue bid submit failed: ${res.status}`);
    return res.text();
  }

  // Parse person XML to extract active bid, absences, category info
  parsePersonData(xml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');

    const person = doc.querySelector('Person');
    const category = doc.querySelector('Category');
    const currentBid = doc.querySelector('CurrentBid');
    const defaultBid = doc.querySelector('DefaultBid');

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
      absences,
      currentBid: currentBid ? xml : null,
      defaultBid: defaultBid ? xml : null
    };
  }

  // Parse pairings XML into array of pairing objects
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
