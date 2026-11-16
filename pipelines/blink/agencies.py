"""Public Transit: the agencies whose open GTFS the network pipeline (static.py) builds, and their terms.

Only feeds that need no key and allow public display are listed. The live (GTFS-Realtime) side is the relay's
allow-list in workers/bct-relay/src/agencies.js and the page's region list in site/src/blink/regions.js: keep the
three in step when adding an agency (same id everywhere).

Keyed feeds stay out until the owner decides (no accounts, no keys here): TransLink realtime (free key), TriMet
(AppID), 511 SF Bay (Muni, AC Transit, Caltrain…; free token), Puget Sound OneBusAway (Sound Transit realtime; key),
Swiftly-hosted feeds (LA Metro, Las Vegas RTC, San Diego MTS; key on request). See docs/data-limits.md.
"""
from __future__ import annotations

BCT_STATIC = "https://bct.tmix.se/Tmix.Cap.TdExport.WebApi/gtfs/?operatorIds={op}"
BCT_TERMS = "https://www.bctransit.com/open-data/terms-of-use"
BCT_CREDIT = "BC Transit (GTFS and GTFS-Realtime), under the BC Transit GTFS Data Terms of Use. Not endorsed by BC Transit."

# BC Transit systems (operatorIds from bctransit.com/open-data, checked 2026-11-13). Every one publishes static GTFS
# and all three GTFS-Realtime feeds on the same tmix host. Systems that share an operator id are one feed.
BCT_SYSTEMS = {
    "victoria": (48, "Victoria"),
    "nanaimo": (41, "Nanaimo"),
    "kelowna": (47, "Kelowna"),
    "kamloops": (46, "Kamloops"),
    "fraser-valley": (13, "Central Fraser Valley · Chilliwack · Agassiz-Harrison · Hope"),
    "comox-valley": (45, "Comox Valley"),
    "cowichan-valley": (10, "Cowichan Valley"),
    "campbell-river": (12, "Campbell River"),
    "port-alberni": (11, "Port Alberni"),
    "squamish": (43, "Squamish"),
    "whistler": (44, "Whistler"),
    "pemberton": (50, "Pemberton Valley"),
    "sunshine-coast": (18, "Sunshine Coast"),
    "powell-river": (29, "Powell River"),
    "salt-spring": (39, "Salt Spring Island"),
    "west-coast": (51, "West Coast (Tofino · Ucluelet)"),
    "mount-waddington": (17, "Mount Waddington"),
    "vernon": (14, "Vernon · Shuswap"),
    "south-okanagan": (15, "South Okanagan-Similkameen (Penticton)"),
    "west-kootenay": (20, "West Kootenay (Nelson · Trail · Castlegar)"),
    "east-kootenay": (21, "East Kootenay (Cranbrook · Kimberley · Elk Valley · Columbia Valley)"),
    "creston-valley": (16, "Creston Valley"),
    "revelstoke": (36, "Revelstoke"),
    "merritt": (37, "Merritt"),
    "ashcroft": (38, "Ashcroft · Cache Creek · Clinton"),
    "clearwater": (35, "Clearwater"),
    "100-mile-house": (34, "100 Mile House"),
    "williams-lake": (33, "Williams Lake"),
    "quesnel": (32, "Quesnel"),
    "prince-george": (22, "Prince George · Bulkley-Nechako"),
    "smithers": (31, "Smithers"),
    "skeena": (26, "Terrace · Kitimat · Hazeltons"),
    "prince-rupert": (23, "Prince Rupert · Port Edward"),
    "fort-st-john": (28, "Fort St. John"),
    "dawson-creek": (27, "Dawson Creek"),
}

AGENCIES: dict[str, dict] = {
    **{k: {"name": f"BC Transit · {n}", "operator": "BC Transit", "static": BCT_STATIC.format(op=op), "terms": BCT_TERMS,
           "credit": BCT_CREDIT, "refresh_h": 7 * 24, "tz": "America/Vancouver"}      # no ETag / Last-Modified: weekly
       for k, (op, n) in BCT_SYSTEMS.items()},
    "king-county": {
        "name": "King County Metro", "operator": "King County Metro", "static": "https://metro.kingcounty.gov/GTFS/google_transit.zip",
        "terms": "https://kingcounty.gov/en/dept/metro/rider-tools/mobile-and-web-apps",
        "credit": "Transit scheduling, geographic, and real-time data provided by permission of King County.",
        "tz": "America/Los_Angeles"},
    "ttc": {
        "name": "TTC", "operator": "Toronto Transit Commission",
        "static": "https://opendata.toronto.ca/toronto.transit.commission/ttc-routes-and-schedules/OpenData_TTC_Schedules.zip",
        "terms": "https://open.toronto.ca/open-data-licence/",
        "credit": "Contains information licensed under the Open Government Licence – Toronto.", "tz": "America/Toronto"},
    "calgary": {
        "name": "Calgary Transit", "operator": "Calgary Transit", "static": "https://data.calgary.ca/download/npk7-z3bj/application%2Fzip",
        "terms": "https://data.calgary.ca/stories/s/u45n-7awa/",
        "credit": "Contains information licensed under the Open Government Licence – City of Calgary.", "tz": "America/Edmonton"},
    "edmonton": {
        "name": "Edmonton Transit Service", "operator": "City of Edmonton", "static": "https://gtfs.edmonton.ca/TMGTFSRealTimeWebService/GTFS/GTFS.zip",
        "terms": "https://www.edmonton.ca/sites/default/files/public-files/assets/Web-version2.1-OpenDataAgreement.pdf",
        "credit": "Contains data from the City of Edmonton Open Data Terms of Use.", "tz": "America/Edmonton"},
    "mbta": {
        "name": "MBTA", "operator": "Massachusetts Bay Transportation Authority", "static": "https://cdn.mbta.com/MBTA_GTFS.zip",
        "terms": "https://www.mass.gov/files/documents/2017/10/27/develop_license_agree_0.pdf",
        "credit": "Data provided by MassDOT / MBTA under the MassDOT Developers License Agreement.", "tz": "America/New_York"},
    "sacrt": {
        "name": "SacRT", "operator": "Sacramento Regional Transit", "static": "https://apps.sacrt.com/gtfs/srtd/google_transit.zip",
        "terms": "https://www.sacrt.com/transit-data-portal/",
        "credit": "Data from Sacramento Regional Transit (SacRT) under its data licence agreement.", "tz": "America/Los_Angeles"},
    "bart": {
        "name": "BART", "operator": "Bay Area Rapid Transit", "static": "https://www.bart.gov/dev/schedules/google_transit.zip",
        "terms": "https://www.bart.gov/schedules/developers/developer-license-agreement",
        "credit": "Schedule and real-time data from BART under the BART Developer License Agreement.", "tz": "America/Los_Angeles"},
    # timetables only: TransLink's realtime needs a (free) key, which stays the owner's choice
    "translink": {
        "name": "TransLink", "operator": "TransLink", "static": "https://gtfs-static.translink.ca/gtfs/google_transit.zip",
        "terms": "https://www.translink.ca/about-us/doing-business-with-translink/app-developer-resources/gtfs/gtfs-data",
        "credit": "Route and arrival data used in this product or service is provided by permission of TransLink. TransLink assumes no responsibility for the accuracy or currency of the Data used in this product or service.",
        "tz": "America/Vancouver", "static_only": True},
}
