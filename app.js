/* TODO -

 - About/documentation popup (including citation advice, warning about https redirection for GOAT)
 - Generate .osm files for multipolygon footprints (function makeFootprintOsmFile)
 - Add noscript message
 - Populate addressRangeList (not sure if this is worth doing without the full address range data from GOAT.)

*/

document.getElementById('searchInputId').addEventListener('keyup', checkSearchKey);
const searchInput = document.getElementById('searchInputId');
const addressDiv = document.getElementById('addressDivId');
const binDiv = document.getElementById('binDivId');
const bblDiv = document.getElementById('bblDivId');
const addressRangeList = document.getElementById('addressRangeListId');
const infoTable = document.getElementById('infoTableId');
const bblRegex = /^([1-5])([0-9]{5})([0-9]{4})$/;
const boros = ['Manhattan', 'Bronx', 'Brooklyn', 'Queens', 'Staten Island'];
var slippyMap = null;
var markerLatLon = null;
var footprintJson = [];
var footprintDrawn = false;

const params = (new URL(document.location)).searchParams;
const paramSearch = params.get('search');
if (paramSearch === null) {
    clearSearchLog();
    slippyMapDefault();
} else {
    searchInput.value = paramSearch.trim();
    doSearch();
}


/* SEARCH FUNCTIONS */

function checkSearchKey(e) {
    if (e.keyCode === 13) {
        doSearch();
    }
}

async function doSearch() {
    const searchText = searchInput.value.trim();
    searchInput.value = searchText;
    clearIoElements();
    clearSearchLog();
    markerLatLon = null;
    footprintJson = [];
    footprintDrawn = false;

    if (validBin(searchText)) {
        writeSearchLog('Search text "' + searchText + '" looks like a BIN\r\nAttempting BIN search...\r\n');
        writeBin(searchText);
        await doBinSearch(searchText);
    } else {
        writeSearchLog('Search text "' + searchText + '" ' + "doesn't look like a BIN\r\nAttempting address search...\r\n");
        await doAddressSearch(searchText);
    }

    if (addressDiv.innerHTML === '') {
        writeFailedAddress();
    }

    if (!footprintDrawn) {
        /* No footprint was drawn... If we got latlon from one from the API calls, add a marker and zoom
        there, otherwise reset map to default state. */
        if (markerLatLon === null) {
            slippyMapDefault();
        } else {
            slippyMapAddMarker(markerLatLon);
        }
    }
}

async function doAddressSearch(searchText) {
    /* For the address search, we'll use the NYC GeoSearch API (https://geosearch.planninglabs.nyc)
    which takes freeform address search text and returns a list of the most likely matching
    addresses with their associated BINs and other info.

    It works well even with minimal input, eg "32 middagh" will return only one item -- BIN 3001569,
    32 MIDDAGH STREET BROOKLYN -- without the need to specify "street" or "brooklyn" in the search.
    In this case the query is unambiguous, as there's only one road named Middagh in NYC, and
    there's only one building on that road with housenumber 32.

    In cases where there is possible ambiguity, the results will be ordered by likelihood. This
    order is sometimes a little arbitrary, eg the results list for "32 cranberry" ranks 32
    Cranberry Court in Staten Island first, and then 32 Cranberry Street in Brooklyn. If the
    Brooklyn result is preferred, the search text can be made more explicit -- "32 cranberry st" or
    "32 cranberry brooklyn" will both work. (The NYC GeoSearch can also be called in "autocomplete"
    mode to give realtime user feedback during search text entry, displaying the results list and
    allowing a user to pick -- but given the generally excellent search result quality, the added UI
    complexity isn't worth it, and also this wouldn't be possible when using a "?search=" url
    parameter.)

    In rare cases, a search will yield a result list whose top-ranked item is problematic or
    outright incorrect, eg:
        - "87 3rd Avenue Brooklyn" ranks BIN 1006851 in Manhattan above BIN 3329450 in Brooklyn,
          despite the literal string "Brooklyn" in the search text.
        - "400 Union" ranks 400 CLASSON AVENUE above 400 UNION AVENUE and 400 UNION STREET. Some
          addresses on Classon Avenue are apparently also indexed as "UNION PLACE" and NYC
          GeoSearch prioritizes these; not sure if this is an error or an addressing quirk.
        - "7517 Colonial Road" ranks the secondary structure BIN 3361003 (7517 GARAGE COLONIAL
          ROAD) ahead of the main structure BIN 3148644 (7517 COLONIAL ROAD).

    To fix these ordering issues, we have functions to compute a custom sort rank based on the
    search text:
        - If NYC GeoSearch's parser identifies a borough (or a likely borough abbreviation
          identified as city, state, or region) in the search string, we prioritize results
          matching that borough.
        - If NYC GeoSearch's parser identifies a street name in the search string, we
          prioritize results that include that street name
        - We de-prioritize results with a housenumber suffix (GARAGE, REAR, etc) unless that
          suffix or a likely abbreviation appears in the search string.
        - All else being equal, we trust NYC GeoSearch's sort order.
    */

    function boroMatchRank(resultBin, searchBoro) {
        if (searchBoro === 0) {
            return 200000;
        }
        if (resultBin.slice(0,1) === searchBoro.toString()) {
            return 100000;
        }
        return 900000;
    }

    function streetMatchRank(resultStreet, searchStreet) {
        if (searchStreet === '') {
            return 30000;
        }
        if (searchStreet === resultStreet) {
            return 10000;
        }
        if (resultStreet.includes(searchStreet)) {
            return 20000;
        }
        return 90000;
    }

    function suffixMatchRank(resultHousenumber, searchText) {

        function suffixAlts(suffix) {
            for (a of [['A GAR', 'A GARAGE'],
             ['AIR', 'AIR RGTS', 'AIR RIGHT', 'AIR RIGHTS'],
             ['B GAR', 'B GARAGE'],
             ['FRONT', 'FRT'],
             ['FRONT A', 'FRT A'],
             ['FRONT B', 'FRT B'],
             ['GAR', 'GARAGE'],
             ['INTER A', 'INT A'],
             ['INTER B', 'INT B'],
             ['UND', 'UNDER', 'UNDRGRND', 'UNDERGROUND']]) {
                if (a.includes(suffix)) {
                    return a;
                }
            }
            return [suffix];
        }

        const reMatch = resultHousenumber.match(/[A-Z\s-]+$/);
        if (reMatch === null) {
            return 2000;
        }
        for (s of suffixAlts(reMatch[0].trim())) {
            if ((searchText + ' ').includes(s + ' ')) {
                 return 1000;
            }
        }
        return 9000;
    }

    const nycGeosearchApiQuery = 'https://geosearch.planninglabs.nyc/v1/search?text=' + encodeURIComponent(searchText);
    writeSearchLog('\r\n"NYC GeoSearch" API query ' + nycGeosearchApiQuery + '\r\n');
    let response = await fetch(nycGeosearchApiQuery);
    if (response.ok) {
        let json = await response.json();
        let parserDesc = ' - unspecified parser found ';
        if (typeof json.geocoding.query.parser !== 'undefined') {
            parserDesc = ' - parser "' + json.geocoding.query.parser + '" found ';
        }
        writeSearchLog(parserDesc + JSON.stringify(json.geocoding.query.parsed_text) + '\r\n');
        let guessedBoroNum = 0;
        if (typeof json.geocoding.query.parsed_text.borough !== 'undefined') {
            guessedBoroNum = guessBoroNum(json.geocoding.query.parsed_text.borough);
        } else if (typeof json.geocoding.query.parsed_text.regions !== 'undefined') {
            guessedBoroNum = guessBoroNum(json.geocoding.query.parsed_text.regions[0]);
        } else if (typeof json.geocoding.query.parsed_text.city !== 'undefined') {
            guessedBoroNum = guessBoroNum(json.geocoding.query.parsed_text.city);
        } else if (typeof json.geocoding.query.parsed_text.state !== 'undefined') {
            guessedBoroNum = guessBoroNum(json.geocoding.query.parsed_text.state);
        }
        if (guessedBoroNum === 0) {
            writeSearchLog(' - search text does not appear to specify a boro\r\n');
        } else {
            writeSearchLog(' - search text appears to specify boro ' + guessedBoroNum + ' (' + boros[guessedBoroNum-1] + ')\r\n');
        }

        if (json.features.length === 0) {
            writeSearchLog(' - no NYC Geosearch results');
        } else {
            if (json.features.length === 1) {
                writeSearchLog(' - only one NYC Geosearch result');
            } else {
                let upperSearch = searchText.toUpperCase();
                let upperStreet = '';
                if (typeof json.geocoding.query.parsed_text.street !== 'undefined') {
                    upperStreet = json.geocoding.query.parsed_text.street.toUpperCase();
                }
                for (let i = 0; i < json.features.length; i++) {
                    console.log(json.features[i]);
                    console.log(upperStreet);
                    json.features[i].nycaabs_sort_rank = boroMatchRank(json.features[i].properties.pad_bin, guessedBoroNum) + streetMatchRank(json.features[i].properties.pad_orig_stname, upperStreet) + suffixMatchRank(json.features[i].properties.housenumber, upperSearch) + i;
                }
                json.features.sort(function(a, b) { return a.nycaabs_sort_rank - b.nycaabs_sort_rank; });
                writeSearchLog(' - ' + json.features.length + ' NYC Geosearch results, using top result after custom sort');
            }

            let geosearchResult = json.features[0];
            let bin = geosearchResult.properties.pad_bin ?? '';
            let boroCode = bin.slice(0,1);
            if (boroCode === guessedBoroNum.toString()) {
                writeSearchLog(', matches search boro\r\n');
            } else {
                writeSearchLog(', no boro match\r\n');
            }
            let houseNumber = geosearchResult.properties.housenumber ?? '';
            let street = geosearchResult.properties.pad_orig_stname ?? '';
            let bbl = geosearchResult.properties.pad_bbl ?? '';
            /* We also have geosearchResult.properties.borough but we don't really need it since
            we're setting the boro based on the first digit of the bin. If someday we want to show
            zip codes, we can use geosearchResult.properties.postalcode but the quality of this
            field is unknown.
            */

            /* BIG TODO -- At this point it would be great to take the address components (maybe as
            returned in the parsed_text structure above, or failing that from the top search result,
            or failing that parse the text ourselves) and feed them into a "Function1A" query on the
            NYC Planning Geoservice API https://geoservice.planning.nyc.gov/, which has important
            advantages over the NYC GeoSearch API:
             - First, it returns address ranges for all streets of multi-street buildings. (NYC
               GeoSearch only returns the address range on the queried street.)
             - Second, it gives additional address classification info (See "Address Types" at
               http://a030-goat.nyc.gov/goat/Glossary for documentation.)
             - Third, it can find recently updated addresses and BINs by accessing the Transitional
               PAD file (TPAD). NYC GeoSearch uses the standard PAD file, which is only updated
               quarterly.

            If we could get decent results from the NYC Planning Geoservice API, we probably
            wouldn't even need to sort or further examine the NYC GeoSearch results. (Curse these
            very similar names!) However, access to NYC Planning Geoservice requires registration
            and department approval, and will only work with a city-issued private API key. This app
            is currently being hosted on github.io, though, so keeping the API key private isn't
            possible.

            There's a web app wrapper around the NYC Planning Geoservice API called "GOAT",
            http://a030-goat.nyc.gov/goat/. The GOAT app supports URL query parameters and is free
            to use without credentials, but its cross-site scripting policy prevents us from screen-
            scraping the results from our own web app. In theory we could attempt to work around
            this with a CORS proxy but that's messy. (GOAT is also available as a downloadable
            offline desktop app, but that version only uses the standard PAD file, not the TPAD
            file.)

            For now, we'll simply rely on the results from the NYC GeoSearch with the following
            known limitations:
             - Slightly out-of-date data (PAD only, not TPAD) that will not reflect newer
               developments and may return obsolete or temporary BINs instead of current ones.
             - Incomplete housenumber range info, especially for multi-street buildings.
             - Need custom sort to downrank occasional results in the wrong borough, unsolicited
               GARAGE or REAR results, etc, as described in the comment at this top of this
               function.
            */

            writeSearchLog(' - showing address ' + houseNumber + ' ' + street + ', boro ' + boroCode + '\r\n');
            writeAddress(houseNumber, street, boroCode);

            const reMatch = bbl.match(bblRegex);
            if (reMatch === null) {
                writeSearchLog(' - not using invalid BBL ' + bbl + '\r\n');
            } else {
                writeSearchLog(' - showing BBL ' + bbl + '\r\n');
                writeBbl(reMatch[1], reMatch[2], reMatch[3]);
            }

            if (validBin(bin)) {
                writeSearchLog(' - showing BIN ' + bin + '\r\n');
                writeBin(bin);
                await doBinSearch(bin);
            } else {
                writeSearchLog(' - showing invalid BIN ' + bin + ', deeper search impossible without a valid BIN\r\n');
                writeInvalidBin(bin);
            }

            if ((Array.isArray(geosearchResult.geometry.coordinates)) && (geosearchResult.geometry.coordinates[0] < -73) && (geosearchResult.geometry.coordinates[0] > 40)) {
                markerLatLon = [geosearchResult.geometry.coordinates[1], geosearchResult.geometry.coordinates[0]];
            }
        }
    } else {
        writeSearchLog(' - error ' + response.status + ' "' + response.statusText + '"');
    }
}

async function doBinSearch(bin) {
    await doFootprintSearch(bin);
    await doDobJobSearch(bin);
    await doDobNowSearch(bin);
}

async function doFootprintSearch(bin) {

    function footprintFeatureText(featureCode) {
        //Codes taken from https://github.com/CityOfNewYork/nyc-geo-metadata/blob/master/Metadata/Metadata_BuildingFootprints.md and https://github.com/CityOfNewYork/nyc-planimetrics/blob/master/Capture_Rules.md#building-footprint
        const featureCodes = {
            2100: 'Building',
            5100: 'Construction',
            2110: 'Garage',
            1001: 'Fuel Canopy',
            1002: 'Tank',
            1003: 'Placeholder',
            1004: 'Auxiliary',
            1005: 'Temporary',
            5110: 'Garage'
        };
        const feature = featureCodes[featureCode];
        if (typeof(feature) === 'undefined') {
            return featureCode;
        }
        return feature;
    }

    let row = infoTable.insertRow(-1);
    row.className = 'rowHead';
    row.innerHTML = '<td>Footprint</td><td>Yr Built</td><td>Status</td><td>Date</td><td>Height</td>';
    /* From April 26th to May 4th 2022, the building footprints API switched places with the
    building center points API, presumably erroneously. If this happens again, change the API url
    from https://data.cityofnewyork.us/resource/qb5r-6dgf.json (documented at
    https://data.cityofnewyork.us/Housing-Development/Building-Footprints/nqwf-w8eh as the
    "building" endpoint) to https://data.cityofnewyork.us/resource/7w4b-tj9d.json (documented as the
    "building_p" endpoint). If this is a recurring problem, we can switch to always checking
    "building_p" if "building" doesn't give us a footprint.
    */
    const footprintApiQuery = 'https://data.cityofnewyork.us/resource/qb5r-6dgf.json?bin=' + bin;
    writeSearchLog('\r\n"Building Footprints" API query ' + footprintApiQuery + '\r\n');
    let response = await fetch(footprintApiQuery);
    if (response.ok) {
        footprintJson = await response.json();
        if (footprintJson.length > 0) {
            let needBbl = (bblDiv.innerHTML === '');
            let heightInMeters = '';
            let formattedHeight = '';
            let footprintLinks = '';
            if (footprintJson.length === 1) {
                writeSearchLog(' - only one footprint result for this BIN\r\n');
            } else {
                writeSearchLog(' - ' + footprintJson.length + ' footprint results for this BIN\r\n');
            }
            /* Loop through footprint results, adding footprints to slippy map and crafting download
            links. Theoretically we might want to reverse sort by status date, but I haven't bothered
            since I've never actually seen more than one result for a valid BIN. If we did ever have
            multiple footprints, only the first one would be added to the map, and the BBL shown would
            likely be from the first one as well (if it hadn't already been found by an address
            search.) */
            for (let i = 0; i < footprintJson.length; i++) {
                //Take the BBL from this footprint record, if it's valid and needed
                if (needBbl) {
                    const bbl = footprintJson[i].base_bbl.trim();
                    const reMatch = bbl.match(bblRegex);
                    if (reMatch === null) {
                        writeSearchLog(' - not using invalid BBL ' + bbl + '\r\n');
                    } else {
                        writeBbl(reMatch[1], reMatch[2], reMatch[3]);
                        writeSearchLog(' - showing BBL ' + bbl + '\r\n');
                        needBbl = false;
                    }
                }

                if (!footprintDrawn) {
                    slippyMapAddFootprint(footprintJson[i].the_geom);
                    footprintDrawn = true;
                }

                row = infoTable.insertRow(-1);
                row.className = 'rowBg' + (i % 2);
                if (typeof footprintJson[i].heightroof === 'undefined') {
                    heightInMeters = '';
                    formattedHeight = '?';
                } else {
                    heightInMeters = feetToMeters(footprintJson[i].heightroof);
                    formattedHeight = formatHeight(footprintJson[i].heightroof, heightInMeters);
                }

                if (footprintJson[i].the_geom.type == 'MultiPolygon') {
                    footprintLinks = '<a href="data:text/xml;charset=utf-8,' + encodeURIComponent(makeFootprintOsmFile(i, bin, heightInMeters)) + '" download="bin' + bin + '_footprint.osm">Download as .osm</a>';
                    /* JOSM's remote control "add_way" command can't handle a multipolygon footprint,
                    so only generate the "Send to JOSM" link if this is a single-shape multipolygon
                    (ie, not a multipolygon at all -- but they're always listed as 'MultiPolgon' in the
                    API). At some point we might want to try JOSM's "load_data" remote control command,
                    which would probably enable us to send an XML-encoded multipolygon directly from
                    the browser. In theory we might also want to skip the "Send to JOSM" link for
                    extremely complex polygons with many nodes that would result in a URL too long for
                    the browser to handle. Maybe scan through the most complex footprints to see if
                    this is a reasonable concern.
                    */
                    if (footprintJson[i].the_geom.coordinates[0].length === 1) {
                        footprintLinks += ' <a class="josmLink" href="#0" onclick="javascript:sendFootprintToJosm(' + i + ', &apos;' + bin + '&apos;, &apos;' + heightInMeters + '&apos;)">Send to JOSM</a>';
                    } else {
                        footprintLinks += ' [multipolygon]';
                    }
                    /* Possibly consider a geojson download link as well -- iD users would be able to load
                       this, though it only works as an imagery layer, not importable data. */
                } else {
                    footprintLinks = '';
                }

                row.innerHTML = '<td>' + footprintFeatureText(footprintJson[i].feat_code) + '</td><td>' + (footprintJson[i].cnstrct_yr ?? '?') + '</td><td>' + footprintJson[i].lststatype + '</td><td>' + footprintJson[i].lstmoddate.slice(0,10) + '</td><td>' + formattedHeight + '</td><td class="tdLink">' + footprintLinks + '</td>';
            }
        } else {
            writeSearchLog(' - no footprint results for this BIN\r\n');
            row = infoTable.insertRow(-1);
            row.innerHTML = '<td>none found</td>';
        }
    } else {
        writeSearchLog(' - error ' + response.status + ' "' + response.statusText + '"');
    }
}

async function doDobJobSearch(bin) {

//TODO -- add height into this sort as well, favoring results with a height
    function dobJobSortRank(type, date) {
        /* Ideally I want the top sort entry to be the same job you'd get if you searched this BIN in
        BIS -- because that's the job that usually links to the zoning documents. My working theory is
        that BIS will return the newest NB (new building) job, and if no NB job is on record, then the
        newest A1, then A2, then A3 (various levels of building alterations) and after that who knows.
        So that's what this sort rank does. I have my doubts that this approach will work every time,
        but I haven't found any counterexamples yet. (Please report if found!)

        The full list of DOB job types (taken from BIS's JobsQueryByLocationServlet page) is:
          A1 - ALTERATION TYPE 1
          A2 - ALTERATION TYPE 2
          A3 - ALTERATION TYPE 3
          DM - FULL DEMOLITION
          NB - NEW BUILDING
          PA - PLACE OF ASSEMBLY
          PR - LAA (ARA)
          SC - SUBDIVISION - CONDO
          SG - SIGN
          SI - SUBDIVISION - IMPROVED
          SU - SUBDIVISION - UNIMPROVED
        */
        const jobTypes = ['A3', 'A2', 'A1', 'NB'];
        return parseInt(String(jobTypes.indexOf(type) + 1) + date.slice(-4) + date.slice(0,2) + date.slice(3,5));
    }

    function formatDate(mmxddxyyyy) {
        return mmxddxyyyy.slice(-4) + '-' + mmxddxyyyy.slice(0,2) + '-' + mmxddxyyyy.slice(3,5);
    }

    const maxResults = 15;
    let row = infoTable.insertRow(-1);
    row.className = 'rowHead';
    row.innerHTML = '<td>DOB Job</td><td>Type</td><td>Status</td><td>Date</td><td>Height</td><td class="tdLink"><a href="' + constructUrlBisJobs(bin) + '">Job&nbsp;List&nbsp;@&nbsp;BIS</a> <a href="' + constructUrlBisJobs(bin, 'A') + '">Active&nbsp;Zoning&nbsp;Job&nbsp;@&nbsp;BIS</a></td>';
    let dobJobApiQuery = 'https://data.cityofnewyork.us/resource/ic3t-wcy2.json?$select=distinct%20job__,house__,street_name,borough,block,lot,job_type,job_status,latest_action_date,job_s1_no,proposed_height,gis_latitude,gis_longitude&$where=bin__=%27' + bin + '%27';
    writeSearchLog('\r\n"DOB Job Application Filings" API query ' + dobJobApiQuery + '\r\n');
    let response = await fetch(dobJobApiQuery);
    if (response.ok) {
        let json = await response.json();
        let j = json.length;
        if (j > 0) {
            let needAddress = (addressDiv.innerHTML === '');
            let houseNumber = '';
            let street = '';
            let boroCode = bin.slice(0,1);
            let needBbl = (bblDiv.innerHTML === '');
            let jobLot = '';
            let jobBlock = '';
            if (j === 1) {
                writeSearchLog(' - only one DOB Job Application result for this BIN\r\n');
            } else if (j > maxResults) {
                writeSearchLog(' - ' + j + ' DOB Job Application results for this BIN, only showing the top ' + maxResults + '\r\n');
                j = maxResults;
            } else {
                writeSearchLog(' - ' + j + ' DOB Job Application results for this BIN\r\n');
            }
            //TODO -- add height into this sort as well, favoring results with a height
            json.sort(function(a, b) { return dobJobSortRank(b.job_type, b.latest_action_date) - dobJobSortRank(a.job_type, a.latest_action_date); });
            for (let i = 0; i < j; i++) {

                if (needAddress) {
                    houseNumber = json[i].house__ ?? '';
                    street = json[i].street_name ?? '';
                    if (houseNumber !== '' && street !== '') {
                        writeSearchLog(' - showing address ' + houseNumber + ' ' + street + ', boro ' + boroCode + '\r\n');
                        writeAddress(houseNumber, street, boroCode);
                        needAddress = false;
                    }
                }

                if (needBbl) {
                    jobBlock = json[i].block.trim();
                    jobLot = json[i].lot.trim();
                    if (jobBlock !== '' && jobLot !== '') {
                        writeBbl(boroCode, json[i].block, json[i].lot);
                        writeSearchLog(' - showing BBL ' + boroCode + json[i].block + json[i].lot + ' from result ' + i + '\r\n');
                        needBbl = false;
                    }
                }

                if (markerLatLon === null) {
                    if ((json[i].gis_latitude > 40) && (json[i].gis_longitude < -73)) {
                        markerLatLon = [json[i].gis_latitude, json[i].gis_longitude];
                        writeSearchLog(' - got latlon ' + json[i].gis_latitude + ', ' +  json[i].gis_longitude + ' from result ' + i + '\r\n');
                    }
                }

                row = infoTable.insertRow(-1);
                row.className = 'rowBg' + (i % 2);
                row.innerHTML = '<td>' + json[i].job__ + '</td><td>' + json[i].job_type + '</td><td>' + json[i].job_status + '</td><td>' + formatDate(json[i].latest_action_date) + '</td><td>' + formatHeight(json[i].proposed_height) + '</td><td class="tdLink"><a href="https://a810-bisweb.nyc.gov/bisweb/JobsQueryByNumberServlet?passjobnumber=' + json[i].job__ + '&passdocnumber=01">Job&nbsp;Details&nbsp;@&nbsp;BIS</a> <a href="https://a810-bisweb.nyc.gov/bisweb/JobsZoningDocumentsServlet?&allisn=' + json[i].job_s1_no + '&passjobnumber=' + json[i].job__ + '&passdocnumber=01&allbin=' + bin + '">Zoning&nbsp;Documents&nbsp;@&nbsp;BIS</a></td>';
                //Unclear if we need to send the "passjobnumber" parameter -- experiment
            }
        } else {
            writeSearchLog(' - no DOB Job Application results for this BIN\r\n');
            row = infoTable.insertRow(-1);
            row.innerHTML = '<td>none found</td>';
        }
    } else {
        writeSearchLog(' - error ' + response.status + ' "' + response.statusText + '"');
        row = infoTable.insertRow(-1);
        row.innerHTML = '<td>search error</td>';
    }
}

async function doDobNowSearch(bin) {

    function shortenDobNowStatus(dobNowStatus) {
        let j = dobNowStatus.indexOf(' -');
        if (j > 2) {
            return dobNowStatus.slice(0,j);
        }
        return dobNowStatus.replace('Certificate of Operation', 'Cert');
    }

    let row = infoTable.insertRow(-1);
    row.className = 'rowHead';
    row.innerHTML = '<td>DOB NOW Job</td><td>Type</td><td>Status</td><td>Date</td><td>Height</td>';
    let dobNowJobApiQuery = 'https://data.cityofnewyork.us/resource/w9ak-ipjd.json?$select=distinct%20job_filing_number,house_no,street_name,borough,block,lot,job_type,filing_status,current_status_date,proposed_height,latitude,longitude&$where=bin=%27' + bin + '%27&$order=current_status_date'; //may eventually want to request latlon in this query, in case we don't have it from elsewhere
    writeSearchLog('\r\n"DOB NOW: Build – Job Application Filings" API query ' + dobNowJobApiQuery + '\r\n');
    let response = await fetch(dobNowJobApiQuery);
    if (response.ok) {
        let json = await response.json();
        if (json.length > 0) {
            if (json.length === 1) {
                writeSearchLog(' - only one DOB NOW Job result for this BIN\r\n');
            } else {
                writeSearchLog(' - ' + json.length + ' DOB NOW Job results for this BIN\r\n');
            }
            let j = json.length - 1;
            let needAddress = (addressDiv.innerHTML === '');
            let houseNumber = '';
            let street = '';
            let boroCode = bin.slice(0,1);
            let needBbl = (bblDiv.innerHTML === '');
            let jobLot = '';
            let jobBlock = '';
            let currentStatusDate = '';

            /* I don't have a particular goal with the sort order in the DOB NOW portion of the table, so I'll just show the newest jobs on top. The date is in a sortable format but the API can't do a descending sort, so this loop processes the rows in reverse order. */
            for (let i=0; i <= j; i++) {

                if (needAddress) {
                    houseNumber = json[j-i].house_no ?? '';
                    street = json[j-i].street_name ?? '';
                    if (houseNumber !== '' && street !== '') {
                        writeSearchLog(' - showing address ' + houseNumber + ' ' + street + ', boro ' + boroCode + '\r\n');
                        writeAddress(houseNumber, street, boroCode);
                        needAddress = false;
                    }
                }

                if (needBbl) {
                    jobBlock = json[j-i].block ?? '';
                    jobLot = json[j-i].lot ?? '';
                    if (jobBlock !== '' && jobLot !== '') {
                        jobBlock = jobBlock.padStart(5, '0');
                        jobLot = jobLot.padStart(5, '0');
                        writeBbl(boroCode, jobBlock, jobLot);
                        writeSearchLog(' - showing BBL ' + boroCode + jobBlock + jobLot + ' from result ' + (j-i) + '\r\n');
                        needBbl = false;
                    }
                }

                if (markerLatLon === null) {
                    if ((json[j-i].latitude > 40) && (json[j-i].longitude < -73)) {
                        markerLatLon = [json[j-i].latitude, json[j-i].longitude];
                        writeSearchLog(' - got latlon ' + json[j-i].latitude + ', ' +  json[j-i].longitude + ' from result ' + i + '\r\n');
                    }
                }

                row = infoTable.insertRow(-1);
                row.className = 'rowBg' + (i % 2);
                if (typeof(json[j-i].current_status_date) === 'undefined') {
                    currentStatusDate = '?';
                } else {
                    currentStatusDate = json[j-i].current_status_date.slice(0,10);
                }

                row.innerHTML = '<td>' + json[j-i].job_filing_number + '</td><td>' + json[j-i].job_type + '</td><td>' + shortenDobNowStatus(json[j-i].filing_status) + '</td><td>' + currentStatusDate + '</td><td>' + formatHeight(json[j-i].proposed_height) + '</td>';
            }
        } else {
            writeSearchLog(' - no DOB NOW Job results for this BIN\r\n');
            row = infoTable.insertRow(-1);
            row.innerHTML = '<td>none found</td>';
        }
    } else {
        writeSearchLog(' - error ' + response.status + ' "' + response.statusText + '"');
        row = infoTable.insertRow(-1);
        row.innerHTML = '<td>search error</td>';
    }
}


/* HTML OUTPUT FUNCTIONS */

function writeSearchLog(logText) {
    document.getElementById('searchLogTextareaId').value += logText;
}

function clearSearchLog() {
    document.getElementById('searchLogTextareaId').value = '';
}

function writeAddress(housenumber, street, boroCode) {
    let boroName = boros[parseInt(boroCode)-1];
    addressDiv.innerHTML = '<strong>Address</strong> ' + housenumber + ' ' + street + ' ' + boroName + ' <a href="' + constructUrlBisProfileAddress(housenumber, street, boroCode) + '">Search&nbsp;Address&nbsp;@&nbsp;BIS</a> <a href="' + constructUrlGoat1A(housenumber, street, boroCode) + '">Search&nbsp;Address&nbsp;@&nbsp;GOAT</a>';
}

function writeFailedAddress() {
    addressDiv.innerHTML = '<strong>Address</strong> Not found';
}

function writeBin(bin) {
    binDiv.innerHTML = '<strong>BIN</strong> ' + bin + ' <a href="' + constructUrlBisProfileBin(bin) + '">Property&nbsp;Profile&nbsp;@&nbsp;BIS</a> <a href="' + constructUrlGoatBN(bin) + '">Search&nbsp;BIN&nbsp;@&nbsp;GOAT</a> <a href="' + constructUrlOverpassTurbo(bin) + '">Search&nbsp;BIN&nbsp;@&nbsp;Overpass&nbsp;Turbo</a>';
}

function writeInvalidBin(bin) {
    binDiv.innerHTML = '<strong>BIN</strong> ' + bin + ' (invalid, search halted)';
}

function writeBbl(boro, block, lot) {
    bblDiv.innerHTML = '<strong>BBL</strong> ' + boro + block + lot + ' <a href="' + constructUrlBisBrowse(boro, block) + '">Browse&nbsp;Block&nbsp;@&nbsp;BIS</a> <a href="' + constructUrlBisBrowse(boro, block, lot) + '">Browse&nbsp;BBL&nbsp;@&nbsp;BIS</a> <a href="' + constructUrlZolaLot(boro, block, lot) + '">View&nbsp;BBL&nbsp;@&nbsp;ZoLa</a>';
}

function clearIoElements() {
    addressDiv.innerHTML = '';
    binDiv.innerHTML = '';
    bblDiv.innerHTML = '';
    addressRangeList.innerHTML = '';
    infoTable.innerHTML = '';
}


/* LINK FUNCTIONS */

function constructUrlGoat1A(houseNumber, street, boroCode) {
    return 'http://a030-goat.nyc.gov/goat/Function1A?borough=' + boroCode + '&street=' + encodeURIComponent(street) + '&address=' + encodeURIComponent(houseNumber);
}

function constructUrlBisBrowse(boro, block, lot) {
    let url = 'https://a810-bisweb.nyc.gov/bisweb/PropertyBrowseByBBLServlet?allborough=' + boro + '&allblock=' + block;
    if (typeof lot !== 'undefined') {
        url += '&alllot=' + lot;
    }
    return url;
}

function constructUrlBisJobs(bin, filler) {
    let url = 'https://a810-bisweb.nyc.gov/bisweb/JobsQueryByLocationServlet?allbin=' + bin;
    if (typeof filler !== 'undefined') {
        url += '&fillerdata=' + filler;
    }
    return url;
}

function constructUrlBisProfileAddress(houseNumber, street, boroCode) {
    return 'https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?boro=' + boroCode + '&houseno=' + encodeURIComponent(houseNumber) + '&street=' + encodeURIComponent(street);
}

function constructUrlBisProfileBin(bin) {
    return 'https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?bin=' + bin;
}

function constructUrlZolaLot(boro, block, lot) {
    return 'https://zola.planning.nyc.gov/l/lot/' + boro + '/' + block + '/' + lot;
}

function constructUrlGoatBN(bin) {
    return 'http://a030-goat.nyc.gov/goat/FunctionBN?bin=' + bin;
}

function constructUrlOverpassTurbo(bin) {
    return 'https://overpass-turbo.eu/?Q=%7B%7BgeocodeArea%3Anyc%7D%7D-%3E.nyc%3B%0Anwr%5B%22nycdoitt%3Abin%22~' + bin +  '%5D(area.nyc)%3B%0Aout%3B%0A%3E%3B%0Aout%3B%0A&R';
}

function makeFootprintOsmFile(footprintIndex, bin, heightInMeters) {
    /* Currently the resulting XML data will specify the creation of new nodes when creating the footprint,
    even if OSM already has nodes at the specified coordinates. To avoid duplicate nodes, we might consider
    doing a "map?bbox" request from the OSM API to find any existing nodes with matching coordinates, and using
    those existing nodes in the footprint way instead of adding new ones. This would make it easier to connect
    abutting footprints, which would be good. In rare cases it might also connect a building to a node
    belonging to a non-building, which might be bad. */

    const polygons = footprintJson[footprintIndex].the_geom.coordinates[0]; //only handling a single building shape.... TODO download and scan the full dataset to see if multi-outer-polygon footprints exist
    let osmFileTop = "<?xml version='1.0' encoding='UTF-8'?>\r\n<osm version='0.6' generator='NYCAABS'>\r\n";
    let osmFileBottom = "";
    let i = 0;
    let nodeCoordinates = '';
    if (polygons.length === 1) {
        //this is a single polygon: add nodes, then add way with nodes and tags
        osmFileBottom = "  <way id='-1' action='modify' visible='true'>\r\n";
        let nodes = [];
        let n = -1;
        for (i = 0; i < polygons[0].length; i++) {
            nodeCoordinates = "lat='" + polygons[0][i][1] + "' lon='" + polygons[0][i][0] + "'";
            n = nodes.indexOf(nodeCoordinates);
            if (n === -1) {
                n = nodes.push(nodeCoordinates) - 1;
                osmFileTop += "  <node id='-" + (n + 10000) + "' action='modify' visible='true' " + nodeCoordinates + " />\r\n";
            }
            osmFileBottom += "    <nd ref='-" + (n + 10000) + "' />\r\n";
        }
    } else {
        //this is a multipolygon shape with inner ways: add nodes, add ways with nodes, then add relation with ways and tags
        //TODO -- make this handle multipolygons with inners ways!
        alert('multipolygon footprint export not yet implemented!');
        console.log("HERE'S A MULTIPOLYGON FOOTPRINT, POLYGON COUNT=" + polygons.length);
        for (i = 0; i < polygons.length; i++) {
            console.log("  POLYGON INDEX " + i);
        }
    }
    osmFileBottom += "    <tag k='building' v='yes' />\r\n";
    if (heightInMeters !== '') {
        osmFileBottom += "    <tag k='height' v='" + heightInMeters + "' />\r\n";
    }
    osmFileBottom += "    <tag k='nycdoitt:bin' v='" + bin + "' />\r\n  </way>\r\n</osm>\r\n";
    return osmFileTop + osmFileBottom;
}

async function sendFootprintToJosm(footprintIndex, bin, heightInMeters) {
    /* Note that when adding a new way using the "add_way" remote control command, JOSM will create the nodes
    needed to add the way. But unlike when importing XML data, it will *only* create them if needed. If the
    active JOSM data layer already has a node at the specified coordinates, that will be used instead.
    Three important implications of this:
      - We don't have to explicitly close the way by referencing the same starting and ending node ID, like we
        do when specifying closed ways in OSM XML. As long as the footprint shape starts and ends at the same
        coordinates, JOSM will find the new way's first node and reuse it as the last node, so the footprint
        will be added as a closed way. (Good thing, because the "add_way" command doesn't allow us to specify
        the reuse of a particular node ID.)
      - The new footprint will connect to existing ways in JOSM if they contain nodes at the same coordinates.
        This is most likely to happen if the building footprint in question, or an abutting one, was already
        imported and hasn't been realigned since. Connecting abutting footprints is desired behavior, so we
        issue a JOSM "load_and_zoom" remote control command before the "add_way" command, to make sure any
        neighboring footprints are loaded in the active data layer.
      - There's also a small chance that the new footprint could connect to non-building nodes, which could
        lead to data errors. JOSM's validator might catch these, but of course it's primarily the individual
        mapper's responsibility to check the data for any problems before uploading.
        */
    let nodes = footprintJson[footprintIndex].the_geom.coordinates[0][0];
    let highLat = nodes[0][1];
    let lowLat = nodes[0][1];
    let highLon = nodes[0][0];
    let lowLon = nodes[0][0];
    let addWayUrl = 'http://localhost:8111/add_way?way=' + nodes[0][1] + ',' + nodes[0][0];
    for (let i = 1; i < nodes.length; i++) {
        addWayUrl += ';' + nodes[i][1] + ',' + nodes[i][0];
        highLat = Math.max(highLat,nodes[i][1]);
        lowLat = Math.min(lowLat,nodes[i][1]);
        highLon = Math.max(highLon,nodes[i][0]);
        lowLon = Math.min(lowLon,nodes[i][0]);
    }
    addWayUrl += '&addtags=building=yes%7Cnycdoitt:bin=' + bin;
    if (heightInMeters !== '') {
        addWayUrl+= '%7Cheight=' + heightInMeters;
    }
    let loadAndZoomUrl = 'http://localhost:8111/load_and_zoom?left=' + (lowLon - 0.0005) + '&right=' + (highLon+ 0.0005) + '&top=' + (highLat + 0.0004) + '&bottom=' + (lowLat - 0.0004);
    //This load_and_zoom bbox is not international-date-line-safe... which is ok for NYC.
    await fetch(loadAndZoomUrl);
    fetch(addWayUrl);
}


/* SLIPPY MAP FUNCTIONS */

function slippyMapInit() {
    let haveTileLayer = false;
    if (slippyMap === null) {
        slippyMap = L.map('slippyMapId',
                          {contextmenu: true,
                           contextmenuItems: [{
                             text: 'View at OSM',
                             callback: menuOsmView
                           }, {
                             text: 'Feature query at OSM',
                             callback: menuOsmFeatureQuery
                           }, {
                             text: 'Reverse geocode at OSM',
                             callback: menuOsmReverse
                           }, {
                             text: 'Reverse geocode at Nominatim',
                             callback: menuNominatimReverse
                           }, {
                             text: 'Edit at OSM (iD)',
                             callback: menuOsmEdit
                           }, {
                             text: 'Edit in JOSM',
                             callback: menuJosmEdit
                           }, '-', {
                             text: 'Cyclomedia imagery',
                             callback: menuCyclomedia
                           }, {
                             text: 'Bing Streetside imagery',
                             callback: menuBingStreetside
                           }]
                          });
    } else {
        slippyMap.eachLayer(function (thisLayer) {
                                //We want to keep the tile layer and delete everything else. There's probably
                                //a better way, but checking for null attribution property works.
                                if (thisLayer.getAttribution() === null) {
                                    slippyMap.removeLayer(thisLayer);
                                } else {
                                    haveTileLayer = true;
                                }
                            });
   }
   return haveTileLayer;
}

function slippyMapDefault() {
    let haveTileLayer = slippyMapInit();
    const defaultMapCenter = [40.73, -73.97];
    const defaultMapZoom = 10;
    slippyMap.setView(defaultMapCenter, defaultMapZoom);
    if (!haveTileLayer) {
        slippyMapAddTileLayer();
    }
}

function slippyMapAddFootprint(footprintGeom) {
    let haveTileLayer = slippyMapInit();
    const footprintGeoJson = L.geoJSON({'type': 'Feature', 'geometry': footprintGeom});
    slippyMap.fitBounds(footprintGeoJson.getBounds());
    if (!haveTileLayer) {
        slippyMapAddTileLayer();
    }
    footprintGeoJson.addTo(slippyMap);
}

function slippyMapAddMarker(latlon) {
    let haveTileLayer = slippyMapInit();
    slippyMap.fitBounds([latlon]);
    if (!haveTileLayer) {
        slippyMapAddTileLayer();
    }
    L.marker(latlon).addTo(slippyMap);
}

function slippyMapAddTileLayer() {
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(slippyMap);
}


/* SLIPPY MAP CONTEXT MENU CALLBACK FUNCTIONS */

function menuOsmView(e) {
    window.open('https://www.openstreetmap.org/#map=19/' + e.latlng.lat + '/' + e.latlng.lng, '_blank');
}

function menuOsmEdit(e) {
    window.open('https://www.openstreetmap.org/edit#map=19/' + e.latlng.lat + '/' + e.latlng.lng, '_blank');
}

function menuJosmEdit(e) {
    fetch('http://localhost:8111/load_and_zoom?left=' + (e.latlng.lng - 0.0012) + '&right=' + (e.latlng.lng + 0.0012) + '&bottom=' + (e.latlng.lat - 0.0006) + '&top=' + (e.latlng.lat + 0.0006));
}

function menuCyclomedia(e) {
    window.open('https://www.geocoder.nyc/streetview.html?lnglat=' + e.latlng.lng + ',' + e.latlng.lat, '_blank');
}

function menuBingStreetside(e) {
    window.open('https://www.bing.com/maps?style=x&cp=' + e.latlng.lat + '~' + e.latlng.lng, '_blank');
}

function menuOsmFeatureQuery(e) {
    window.open('https://www.openstreetmap.org/query?lat=' + e.latlng.lat + '&lon=' + e.latlng.lng + '#map=19/' + e.latlng.lat + '/' + e.latlng.lng, '_blank');
}

function menuOsmReverse(e) {
    window.open('https://www.openstreetmap.org/search?whereami=1&query=' + e.latlng.lat + '%2C' + e.latlng.lng + '#map=19/' + e.latlng.lat + '/' + e.latlng.lng, '_blank');
}

function menuNominatimReverse(e) {
    window.open('https://nominatim.openstreetmap.org/ui/reverse.html?lat=' + e.latlng.lat + '&lon=' + e.latlng.lng, '_blank');
}


/* MISC FUNCTIONS */
//some of these might be better moved inside the relevant search functions

function validBin(bin) {
    const reMatch = bin.match(/^[1-5]([0-9]{6})$/);
    return (reMatch !== null) && (reMatch[1] !== '000000');
}

function guessBoroNum(searchBoro) {
    const boroGuesses = { m: 1,
                          q: 4,
                          s: 5,
                          bk: 3,
                          bl: 3,
                          bx: 2,
                          ne: 1,
                          brk: 3,
                          brx: 2,
                          the: 2,
                          broo: 3,
                          bron: 2
                        };
    searchBoro = searchBoro.toLowerCase();
    for (const k in boroGuesses) {
        if (searchBoro.slice(0, k.length) === k) {
            return boroGuesses[k];
        }
    }
    return 0;
}

function feetToMeters(feet) {
    let m = String(Math.round(feet * 3.048));
    return m.slice(0,-1) + '.' + m.slice(-1);
}

function formatHeight(feet, meters) {
    if (typeof feet === 'undefined') {
        return '?';
    }
    return feet + 'ft (' +  (meters ?? feetToMeters(feet)) + 'm)';
}