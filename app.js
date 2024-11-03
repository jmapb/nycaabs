/* TODO -

 - Add noscript message
 - Populate addressRangeList (not sure if this is worth doing without the full address range data from Geosupport.)
 - Expand "Blvd" (maybe also "Blvd."?) before search ("213-03 NORTHERN blvd" gives wrong result)
 - Links to NY state offering plan search
 - 855 Clarkson Brooklyn

 "1745 Forest Avenue, Staten Island, New York 10302" vs "1745 Forest Avenue"??????

 BIN 3428826, 3337899, 3425581  -- examples where DOB has correct building height, height listed with footprint is much higher
*/

document.getElementById('searchInputId').addEventListener('keyup', checkSearchKey);
window.addEventListener('popstate', (event) => { doParamSearch(event.state.search ?? ''); });
const searchInput = document.getElementById('searchInputId');
const addressDiv = document.getElementById('addressDivId');
const binDiv = document.getElementById('binDivId');
const bblDiv = document.getElementById('bblDivId');
const hpdDiv = document.getElementById('hpdDivId');
const buildingClassDiv = document.getElementById('buildingClassDivId');
const addressRangeList = document.getElementById('addressRangeListId');
const infoTable = document.getElementById('infoTableId');
const bblRegex = /^([1-5])([0-9]{5})([0-9]{4})$/;
const latlonRegex = /^\s*([0-9\.]+)[\s,;]+(\-[0-9\.]+)\s*$/;
const urlDobNow = 'https://a810-dobnow.nyc.gov/publish/#!/';
const boros = ['Manhattan', 'Bronx', 'Brooklyn', 'Queens', 'Staten Island'];
var slippyMap = null;
var markerLatLon = null;
var footprintJson = [];
var footprintDrawn = false;
var bin = '';

const params = (new URL(document.location)).searchParams;
const paramSearch = params.get('search');
if (paramSearch === null) {
    clearSearchLog();
    slippyMapDefault();
} else {
    doParamSearch(paramSearch.trim());
}


/* SEARCH FUNCTIONS */

function checkSearchKey(e) {
    if (e.keyCode === 13) {
        doSearch();
    }
}

function doParamSearch(p) {
    searchInput.value = p;
    doSearch(false);
}

async function doSearch(addToHistory = true) {
    const searchText = searchInput.value.trim();
    searchInput.value = searchText;
    clearIoElements();
    clearSearchLog();
    markerLatLon = null;
    footprintJson = [];
    footprintDrawn = false;
    bin = '';
    if (addToHistory) {
        history.pushState({search: searchText}, '', window.location.href.split(/[?#]/)[0] + '?search=' + encodeURIComponent(searchText));
    }

    //document.getElementById('searchLogTextareaId').style.color = 'black';
    const reMatch = searchText.match(latlonRegex);
    if (reMatch !== null) {
        writeSearchLog('Search text "' + searchText + '" ' + "looks like a latlon pair\r\nAttempting latlon search...\r\n");
        await doFootprintLatlonSearch(reMatch[1], reMatch[2]);
    } else if (validBin(searchText)) {
        writeSearchLog('Search text "' + searchText + '" looks like a BIN\r\nAttempting BIN search...\r\n');
        writeBin(searchText);
        await doBinSearch(searchText);
    } else {
        writeSearchLog('Search text "' + searchText + '" ' + "doesn't look like a BIN or latlon\r\nAttempting address search...\r\n");
        await doAddressSearch(searchText);
    }

    if (addressDiv.innerHTML === '') {
        writeFailedAddress();
    }

    if (!footprintDrawn) {
        /* No footprint was drawn... If we got latlon from one of the API calls, add a marker and zoom
        there, otherwise reset map to default state. */
        if (markerLatLon === null) {
            slippyMapDefault();
        } else {
            slippyMapAddMarker(markerLatLon);
        }
    }
}

async function doFootprintLatlonSearch(lat, lon) {
    markerLatLon = [lat, lon];

//    const latLonApiQuery = 'https://data.cityofnewyork.us/api/geospatial/7w4b-tj9d?lat=' + lat + '&lng=' + lon + '&zoom=17';
    const latLonApiQuery = 'https://data.cityofnewyork.us/api/geospatial/qb5r-6dgf?lat=' + lat + '&lng=' + lon + '&zoom=17';
    let fpJson = await httpGetJson(latLonApiQuery, '"Building Footprints" latlon');
    if (fpJson.length > 0) {
        const latlonBin = fpJson[0].bin;
        if (validBin(latlonBin)) {
            writeSearchLog(' - found BIN ' + latlonBin + ', attemping BIN search...\r\n');
            writeBin(latlonBin);
            await doBinSearch(latlonBin);
        }
    }
}

async function doBinSearch(searchBin) {
    bin = searchBin;
    doHpdSearch();
    await doFootprintBinSearch();
    await doDobJobSearch();
    await doDobNowSearch();
}

async function doFootprintBinSearch() {

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
        return featureCodes[featureCode] ?? featureCode;
    }

    let row = infoTable.insertRow(-1);
    row.className = 'rowHead';
    row.innerHTML = '<td>Footprint</td><td>Yr Built</td><td>Status</td><td>Date</td><td>Height</td>';

    const buildingFootprintApiQuery = 'https://data.cityofnewyork.us/resource/qb5r-6dgf.json?bin=' + bin;
    footprintJson = await httpGetJson(buildingFootprintApiQuery, '"Building Footprint" BIN');
    if ((footprintJson[0]?.the_geom?.type ?? '') !== 'MultiPolygon') {
        /* Occasionally, the city's building footprints API (https://data.cityofnewyork.us/resource/qb5r-6dgf.json,
        documented at https://data.cityofnewyork.us/Housing-Development/Building-Footprints/nqwf-w8eh as the
        "building" endpoint) temporarily switches places with the building center points API
        (https://data.cityofnewyork.us/resource/7w4b-tj9d.json, documented as the "building_p" endpoint). Not sure
        what triggers this, but it happens enough that we need to automatically fall back on the "building_p" API
        for footprint geometry if no multipolygon is found in the "building" query. (These datasets describe all
        footprints as "MultiPolygon" even if they're just simple polygons.)
        */
        const buildingPointApiQuery = 'https://data.cityofnewyork.us/resource/7w4b-tj9d.json?bin=' + bin;
        footprintJson = await httpGetJson(buildingPointApiQuery, 'Did not get a footprint, trying "Building Point" BIN');
    }
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
        links. Theoretically we might want to reverse sort by status date, but I've never
        actually seen more than one footprint result for a valid BIN. As of now, if the API did
        return multiple footprints, they would all be listed in the table but only the first
        result would be added to the map.
        */
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

            footprintLinks = '';
            if (footprintJson[i].the_geom.type === 'MultiPolygon') {
                processFootprint(i, bin, heightInMeters);
                if (typeof(footprintJson[i]?.nycaabs_osm_xml) !== 'undefined') {
                    footprintLinks = '<a href="data:text/xml;charset=utf-8,' + encodeURIComponent(footprintJson[i].nycaabs_osm_xml) + '" download="bin' + bin + '_footprint.osm">Download as .osm</a>  <a class="josmLink" href="javascript:void(0);" onclick="javascript:sendFootprintToJosm(' + i + ')">Send to JOSM</a>';
                }
                //Possibly consider a geojson download link as well -- iD users would be able to
                //load this, though it only works as an imagery layer, not importable data.
            }

            row.innerHTML = '<td>' + footprintFeatureText(footprintJson[i].feat_code) + '</td><td>' + (footprintJson[i].cnstrct_yr ?? '?') + '</td><td>' + footprintJson[i].lststatype + '</td><td>' + footprintJson[i].lstmoddate.slice(0,10) + '</td><td>' + formattedHeight + '</td><td class="tdLink">' + footprintLinks + '</td>';
        }
    } else {
        writeSearchLog(' - no footprint results for this BIN\r\n');
        row = infoTable.insertRow(-1);
        row.innerHTML = '<td>none found</td>';
    }
}

async function doHpdSearch() {
    const dobHpdApiQuery = 'https://data.cityofnewyork.us/resource/kj4p-ruqc.json?bin=' + bin;
    let json = await httpGetJson(dobHpdApiQuery, '"Buildings Subject to HPD Jurisdiction"');
    let j = json?.length ?? 0;
    if (j > 0) {
        if (j === 1) {
            writeSearchLog(' - only one HPD result for this BIN\r\n');
        } else {
            writeSearchLog(' - ' + j + ' HPD results for this BIN, using result 0\r\n');
        }
        let needAddress = (addressDiv.innerHTML === '');
        let houseNumber = '';
        let street = '';
        let boroCode = bin.slice(0,1);
        let needBbl = (bblDiv.innerHTML === '');
        let lot = '';
        let block = '';

        if (needAddress) {
            houseNumber = json[0].housenumber ?? '';
            street = json[0].streetname ?? '';
            if (houseNumber !== '' && street !== '') {
                writeSearchLog(' - showing address ' + houseNumber + ' ' + street + ', boro ' + boroCode + '\r\n');
                writeAddress(houseNumber, street, boroCode);
                needAddress = false;
            }
        }

        if (needBbl) {
            block = json[0].block ?? '';
            lot = json[0].lot ?? '';
            if (block !== '' && lot !== '') {
                block = block.padStart(5, '0');
                lot = lot.padStart(5, '0');
                writeBbl(boroCode, block, lot);
                writeSearchLog(' - showing BBL ' + boroCode + block + lot + '\r\n');
                needBbl = false;
            }
        }

        writeHpd(json[0].buildingid);
    } else {
        writeSearchLog(' - no HPD results for this BIN\r\n');
        writeHpd('');
    }
}

async function doDobJobSearch() {

    function dobJobSortRank(type, jobStatus, date, height) {
        /* Ideally I want the top sort entry to be the same job you'd get if you searched this BIN
        in BIS -- because that's the job that usually links to the current zoning documents. Users
        can then simply use the top-ranked "Zoning Docs @ BIS" link to look for the zoning docs,
        using only one request to the BIS server. (Note that there's no guarantee that BIS will have
        any zoning docs on offer, even if we pick the "right" job number.)
        My working theory is that BIS will return the newest non-rejected (status !== 'J') type NB
        (new building) job, and if no NB job is on record, then the newest A1, then A2, then A3
        (various levels of building alterations) and after that who knows. So that's approximately
        what this sort rank does.
        I have my doubts that this approach will work every time, but I don't know of any
        counterexamples at the moment. (Please report if found!)

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
        return parseInt((String(jobTypes.indexOf(type) + ((jobStatus == 'J') ? 1 : 6)) + date.slice(0,4) + date.slice(5,7) + date.slice(8,10)) * 1000000000) + Math.round(height * 1000);
    }

    function expandJobType(code) {
        const jobTypes = { A1: 'Alteration Type 1 (Major alteration, changes to building use or occupancy)',
                           A2: 'Alteration Type 2 (Major alteration, no changes to building use or occupancy)',
                           A3: 'Alteration Type 3 (Minor alteration)',
                           DM: 'Full Demolition',
                           NB: 'New Building',
                           PA: 'Place of Assembly',
                           PR: 'Limited Alteration Application (Alteration Repair Application)',
                           SC: 'Subdivision - Condo',
                           SG: 'Sign',
                           SI: 'Subdivision - Improved',
                           SU: 'Subdivision - Unimproved'
                         };
        return jobTypes[code] ?? 'Unknown job type code ' + code;
    }

    function expandJobStatus(code) {
        const jobStatuses = { A: 'Pre-Filed',
                              B: 'Application Processed - Part-No Payment',
                              C: 'Application Processed - Payment Only',
                              D: 'Application Processed - Completed',
                              E: 'Application Processed - No Plan Exam',
                              F: 'Application Assigned To Plan Examiner',
                              G: 'PAA Fee Due',
                              H: 'Plan Exam - In Process',
                              I: 'Sign-Off (ARA)',
                              J: 'Plan Exam - Disapproved',
                              K: 'Plan Exam - Partial Approval',
                              L: 'Plan Exam PAA - Pending Fee Estimation',
                              M: 'Plan Exam PAA - Fee Resolved',
                              P: 'Plan Exam - Approved',
                              Q: 'Permit Issued - Partial Job',
                              R: 'Permit Issued - Entire Job/Work',
                              U: 'Completed',
                              X: 'Signed-Off',
                              3: 'Suspended'
                            };
        return jobStatuses[code] ?? 'Unknown job status code ' + code;
    }

    function formatDate(input) {
        /* Dates in the city's DOB job dataset are almost all mm/dd/yyyy but there are a few yyyy-mm-dd thrown in
           there just to make things fun, BIN 4097171 eg */
        input = input.trim();
        let matches = input.match(/^(\d\d)\D(\d\d)\D(\d\d\d\d)/);
        if (matches !== null) {
            return matches[3] + '-' + matches[1] + '-' + matches[2];
        }
        return input;
    }

    const buildingClassMap = new Map();
    const maxResults = 15;
    let row = infoTable.insertRow(-1);
    row.className = 'rowHead';
    row.innerHTML = '<td>DOB BIS Job</td><td>Type</td><td>Status</td><td>Date</td><td>Height</td><td class="tdLink"><a href="' + constructUrlBisJobs(bin) + '">Job&nbsp;List&nbsp;@&nbsp;BIS</a> <a href="' + constructUrlBisJobs(bin, 'A') + '">Active&nbsp;Zoning&nbsp;Job&nbsp;@&nbsp;BIS</a></td>';
    let dobJobApiQuery = 'https://data.cityofnewyork.us/resource/ic3t-wcy2.json?$select=distinct%20job__,house__,street_name,borough,block,lot,building_class,job_type,job_status,latest_action_date,proposed_height,gis_latitude,gis_longitude&$where=bin__=%27' + bin + '%27';
    //Note: previously I was also requesting the "job_s1_no" field, and using it to populate the "allisn" url parameter of the BIS Zoning Documents page urls, imitating the urls generated by the BIS web portal. I've concluded that this field isn't neccessary (the Zoning Documents page seems to load just as well without it) so I'm no longer requesting or using it.

    let json = await httpGetJson(dobJobApiQuery, '"DOB Job Application Filings"');
    let j = json?.length ?? 0;
    if (j > 0) {
        let needAddress = (addressDiv.innerHTML === '');
        let houseNumber = '';
        let street = '';
        let boroCode = bin.slice(0,1);
        let needBbl = (bblDiv.innerHTML === '');
        let jobLot = '';
        let jobBlock = '';
        let actionDate = '';
        let buildingClass = '';
        if (j === 1) {
            writeSearchLog(' - only one DOB Job Application result for this BIN\r\n');
        } else if (j > maxResults) {
            writeSearchLog(' - ' + j + ' DOB Job Application results for this BIN, only showing the top ' + maxResults + '\r\n');
            j = maxResults;
        } else {
            writeSearchLog(' - ' + j + ' DOB Job Application results for this BIN\r\n');
        }
        json.sort(function(a, b) { return dobJobSortRank(b.job_type, b.job_status, formatDate(b.latest_action_date), b.proposed_height) - dobJobSortRank(a.job_type, a.job_status, formatDate(a.latest_action_date), a.proposed_height); });
        const listedJobsWithHeight = [];
        let addedRowCount = 0;
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

            actionDate = formatDate(json[i].latest_action_date);
            buildingClass = json[i].building_class.trim();
            if (!buildingClassMap.has(buildingClass) || (actionDate > buildingClassMap.get(buildingClass))) {
                buildingClassMap.set(buildingClass, actionDate);
            }

            if (!listedJobsWithHeight.includes(json[i].job__)) {
                row = infoTable.insertRow(-1);
                row.className = 'rowBg' + (addedRowCount % 2);
                row.innerHTML = '<td>' + json[i].job__ + '</td><td><abbr title="' + expandJobType(json[i].job_type) + '">' + json[i].job_type + '</abbr></td><td><abbr title="' + expandJobStatus(json[i].job_status) + '">' + json[i].job_status + '</abbr></td><td>' + formatDate(json[i].latest_action_date) + '</td><td>' + formatHeight(json[i].proposed_height) + '</td><td class="tdLink"><a href="https://a810-bisweb.nyc.gov/bisweb/JobsQueryByNumberServlet?passjobnumber=' + json[i].job__ + '&passdocnumber=01">Job&nbsp;Details&nbsp;@&nbsp;BIS</a> <a href="https://a810-bisweb.nyc.gov/bisweb/JobsZoningDocumentsServlet?passjobnumber=' + json[i].job__ + '&passdocnumber=01&allbin=' + bin + '">Zoning&nbsp;Docs&nbsp;@&nbsp;BIS</a></td>';
                addedRowCount++;
                if (json[i].proposed_height > 0) {
                    listedJobsWithHeight.push(json[i].job__);
                }
            }
        }
    } else {
        writeSearchLog(' - no DOB Job Application results for this BIN\r\n');
        row = infoTable.insertRow(-1);
        row.innerHTML = '<td>none found</td>';
    }
    writeBuildingClass(buildingClassMap);
}

async function doDobNowSearch() {

    function shortenDobNowStatus(dobNowStatus) {
        let j = dobNowStatus.indexOf(' -');
        if (j > 2) {
            return dobNowStatus.slice(0,j);
        }
        return dobNowStatus.replace('Certificate of Operation', 'Cert of Op');
        //check ?search=40.64242407021607 -73.98076415061952 for another lengthy status
    }

    let row = infoTable.insertRow(-1);
    row.className = 'rowHead';
    row.innerHTML = '<td>DOB NOW Job</td><td>Type</td><td>Status</td><td>Date</td><td>Height</td><td id="dobNowLink" class="tdLink" id="dobNowLink"><a href="' + urlDobNow + '">open DOB NOW w/ BIN in clipboard</a></td>';
    const dobNowLink = document.getElementById('dobNowLink');
    dobNowLink.addEventListener('mouseup', handleDobNowLinkEvents, {capture: true});
    dobNowLink.addEventListener('click', handleDobNowLinkEvents, {capture: true});
    const dobNowJobApiQuery = 'https://data.cityofnewyork.us/resource/w9ak-ipjd.json?$select=distinct%20job_filing_number,house_no,street_name,borough,block,lot,job_type,filing_status,current_status_date,proposed_height,latitude,longitude&$where=bin=%27' + bin + '%27&$order=current_status_date';
    let json = await httpGetJson(dobNowJobApiQuery, '"DOB NOW: Build – Job Application Filings"');
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

            if (typeof(json[j-i].job_filing_number) !== 'undefined') {
                row = infoTable.insertRow(-1);
                row.className = 'rowBg' + (i % 2);
                if (typeof(json[j-i].current_status_date) === 'undefined') {
                    currentStatusDate = '?';
                } else {
                    currentStatusDate = json[j-i].current_status_date.slice(0,10);
                }
                row.innerHTML = '<td>' + json[j-i].job_filing_number + '</td><td>' + json[j-i].job_type + '</td><td>' + shortenDobNowStatus(json[j-i].filing_status) + '</td><td>' + currentStatusDate + '</td><td>' + formatHeight(json[j-i].proposed_height) + '</td>';
            }
        }
    } else {
        writeSearchLog(' - no DOB NOW Job results for this BIN\r\n');
        row = infoTable.insertRow(-1);
        row.innerHTML = '<td>none found</td>';
    }
}


async function doAddressSearch(searchText) {
    /* For the address search, we'll use the NYC GeoSearch API (https://geosearch.planninglabs.nyc)
    which parses freeform address search text and returns a list of the most likely matching
    addresses with their associated BINs and other info.

    It works well even with minimal input, eg "32 middagh" will return BIN 3001569 (32 MIDDAGH
    STREET BROOKLYN) as the top ranked result without the need to specify "street" or "brooklyn" in
    the search. This is unambiguous since there's only one road named Middagh in NYC, and only one
    building on that road with housenumber 32.

    A more ambiguous query, "32 cranberry", ranks 32 Cranberry Court in Staten Island first, and
    then 32 Cranberry Street in Brooklyn. Nycaabs simply uses the top result, so if the Brooklyn
    address is preferred, the search text can be made more explicit by adding "street" or "st".

    Querying the API for "32 cranberry brooklyn" without the street suffix will still return the
    Staten Island address first, however. This is new behavior in v2 of GeoSearch, which appears
    to be much more reliant on the query containing a valid street suffix than v1 did. There are
    definitely some upsides to the v2 API though. The old v1 would sometimes return unquestionably
    incorrect results and, for certain addresses, would *never* rank the right result first no
    matter how explicit the query text.

    For NYC GeoSearch v1, Nycaabs had a multi-tier custom sort to deal with these edge cases. We
    now use a much simpler sort that only compares the boro guessed from the parsed search text
    to the boro of the returned properties. This enables us to search using eg "87 3rd av mn"
    instead of need to spell out "87 3rd av manhattan"

    1515 Park Place
    Franklin Av BK

    The API v2 is still very new and may have its own mysterious edge cases that need massaging.
    Please raise a Github issue at https://github.com/jmapb/nycaabs/issues with examples of any
    address searches that return the wrong property, thanks!

    */

    function boroMatchRank(resultBin, searchBoro) {
        if (searchBoro === 0) {
            return 2000000;
        }
        if (resultBin.slice(0,1) === searchBoro.toString()) {
            return 1000000;
        }
        return 9000000;
    }

    function streetMatchRank(resultStreet, searchStreet) {
        if (searchStreet === '') {
            return 40000;
        }
        if (searchStreet === resultStreet) {
            return 10000;
        }
        if (resultStreet.includes(searchStreet)) {
            return 20000;
        }
        if (searchStreet.includes(resultStreet)) {
            return 30000;
        }
        return 90000;
    }

    function houseNumberMatchRank(resultHouseNumber, searchHouseNumber) {
        if (searchHouseNumber === '') {
            return 4000;
        }
        if (searchHouseNumber === resultHouseNumber) {
            return 1000;
        }
        if (resultHouseNumber.includes(searchHouseNumber)) {
            return 200000;
        }
        if (searchHouseNumber.includes(resultHouseNumber)) {
            return 300000;
        }
        return 900000;
    }

    let parsedAddress = parseNycAddress(searchText);
    writeSearchLog(' - parser "parse-nyc-address" found ' + JSON.stringify(parsedAddress));
    let searchBoroNum = parsedAddress.borough ?? 0;
    let searchStreet = parsedAddress.street ?? '';
    let searchHouseNumber = parsedAddress.housenumber ?? '';

    //To-do if parseNycAddress() gives us street and boro, attempt a Geoservice search.
    //If Geoservice fails us, fall back to NYC GeoSearch

    const nycGeosearchApiQuery = 'https://geosearch.planninglabs.nyc/v2/search?text=' + encodeURIComponent(searchText);
    let json = await httpGetJson(nycGeosearchApiQuery, '"NYC GeoSearch"');

    if (typeof json?.geocoding !== 'undefined') {
        (json.geocoding?.errors ?? []).forEach (error => {
            writeSearchLog(' - GeoSearch error "' + error + '"\r\n');
        });
        let parserDesc = 'an unspecified parser';
        if (typeof json.geocoding?.query?.parser !== 'undefined') {
            parserDesc = 'parser "' + json.geocoding.query.parser + '"';
        }
        if (typeof json.geocoding?.query?.parsed_text !== 'undefined') {
            writeSearchLog(' - GeoSearch used ' + parserDesc + ', parsed address=' + JSON.stringify(json.geocoding.query.parsed_text) + ' \r\n');
        } else {
            writeSearchLog(' - GeoSearch used ' + parserDesc + ', no parsed address was returned\r\n');
        }
    }

    let geosearchResults = json?.features ?? [];
    if (geosearchResults.length === 0) {
        writeSearchLog(' - no NYC GeoSearch results');
    } else {
        if (geosearchResults.length === 1) {
            writeSearchLog(' - only one NYC GeoSearch result');
            //document.getElementById('searchLogTextareaId').style.color = 'blue';
        } else {
            for (let i = 0; i < geosearchResults.length; i++) {
                geosearchResults[i].geosearch_rank = i;
                geosearchResults[i].nycaabs_rank = i + boroMatchRank(geosearchResults[i].properties.addendum.pad.bin, searchBoroNum)
                                                 + streetMatchRank(geosearchResults[i].properties.street, searchStreet)
                                                 + houseNumberMatchRank(geosearchResults[i].properties.housenumber ?? '', searchHouseNumber);
            }
            json.features.sort(function(a, b) { return a.nycaabs_rank - b.nycaabs_rank; });
            if (geosearchResults[0].geosearch_rank === 0) {
                writeSearchLog(' - ' + geosearchResults.length + ' NYC GeoSearch results, using result 0');
            } else {
                writeSearchLog(' - ' + geosearchResults.length + ' NYC GeoSearch results, using result ' + geosearchResults[0].geosearch_rank + ' after custom sort');
                //document.getElementById('searchLogTextareaId').style.color = 'red';
            }
        }

        let gsBin = geosearchResults[0]?.properties?.addendum?.pad?.bin ?? '';
        let boroCode = gsBin.slice(0,1);
        if (boroCode === searchBoroNum.toString()) {
            writeSearchLog(', matches search boro\r\n');
        } else {
            writeSearchLog(', no boro match\r\n');
        }
        let houseNumber = geosearchResults[0]?.properties?.housenumber ?? '';
        let street = geosearchResults[0]?.properties?.street ?? '';
        let bbl = geosearchResults[0]?.properties?.addendum?.pad?.bbl ?? '';
        /* We also have geosearchResult.properties.borough but we don't need it since we're
        setting the boro based on the first digit of the bin. If someday we want to show zip
        codes, we can use geosearchResult.properties.postalcode but the quality of this field
        is unknown.
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
        https://a030-goat.nyc.gov/goat. The GOAT app supports URL query parameters and is free
        to use without credentials, but its cross-site scripting policy prevents us from screen-
        scraping the results from our own web app. In theory we could attempt to work around
        this with a CORS proxy but that's messy. (GOAT is also available as a downloadable
        offline desktop app, but that version only uses the standard PAD file, not the TPAD
        file.)

        For now, we'll simply rely on the results from NYC GeoSearch with the following known
        limitations:
         - Slightly out-of-date data (PAD only, not TPAD) that will not reflect newer
           developments and may return obsolete or temporary BINs instead of current ones.
         - Incomplete housenumber range info, especially for multi-street buildings.
         - Need custom sort to favor results that match the requested borough and street name, as
           described in the comment at this top of this function.
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

        if (validBin(gsBin)) {
            writeSearchLog(' - showing BIN ' + gsBin + '\r\n');
            writeBin(gsBin);
            await doBinSearch(gsBin);
        } else {
            writeSearchLog(' - showing invalid BIN ' + gsBin + ', deeper search impossible without a valid BIN\r\n');
            writeInvalidBin(gsBin);
        }
        if (((geosearchResults[0]?.geometry?.coordinates[0] ?? 0) < -73) && ((geosearchResults[0]?.geometry?.coordinates[1] ?? 0) > 40)) {
            markerLatLon = [geosearchResults[0].geometry.coordinates[1], geosearchResults[0].geometry.coordinates[0]];
            writeSearchLog(' - got latlon ' + markerLatLon[0] + ', ' +  markerLatLon[0] + ' from Geosearch\r\n');
        }
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

function writeBin(wBin) {
    binDiv.innerHTML = '<strong>BIN</strong> ' + wBin + ' <a href="' + constructUrlBisProfileBin(wBin) + '">Property&nbsp;Profile&nbsp;@&nbsp;BIS</a> <a href="' + constructUrlGoatBN(wBin) + '">Search&nbsp;BIN&nbsp;@&nbsp;GOAT</a> <a href="' + constructUrlOverpassTurbo(wBin) + '">Search&nbsp;BIN&nbsp;@&nbsp;Overpass&nbsp;Turbo</a>';
}

function writeInvalidBin(wBin) {
    binDiv.innerHTML = '<strong>BIN</strong> ' + wBin + ' (invalid, search halted)';
}

function writeBbl(boro, block, lot) {
    bblDiv.innerHTML = '<strong>BBL</strong> ' + boro + block + lot + ' <a href="' + constructUrlBisBrowse(boro, block) + '">Browse&nbsp;Block&nbsp;@&nbsp;BIS</a> <a href="' + constructUrlBisBrowse(boro, block, lot) + '">Browse&nbsp;BBL&nbsp;@&nbsp;BIS</a> <a href="' + constructUrlZolaLot(boro, block, lot) + '">View&nbsp;BBL&nbsp;@&nbsp;ZoLa</a>';
}

function writeHpd(hpdId) {
    let hpdHtml = 'Not found';
    if (hpdId !== '') {
        hpdHtml = hpdId + ' <a href="' + constructUrlHpdId(hpdId) + '">Overview&nbsp;@&nbsp;HPD</a>';
    }
    hpdDiv.innerHTML = '<strong>HPD ID</strong> ' + hpdHtml;
}

function writeBuildingClass(buildingClassMap) {

    function expandBuildingClass(code) {
        const buildingClasses = { A0: 'CAPE COD',
                                  A1: 'TWO STORIES - DETACHED SM OR MID',
                                  A2: 'ONE STORY - PERMANENT LIVING QUARTER',
                                  A3: 'LARGE SUBURBAN RESIDENCE',
                                  A4: 'CITY RESIDENCE ONE FAMILY',
                                  A5: 'ONE FAMILY ATTACHED OR SEMI-DETACHED',
                                  A6: 'SUMMER COTTAGE',
                                  A7: 'MANSION TYPE OR TOWN HOUSE',
                                  A8: 'BUNGALOW COLONY - COOPERATIVELY OWNED LAND',
                                  A9: 'MISCELLANEOUS ONE FAMILY',
                                  B1: 'TWO FAMILY BRICK',
                                  B2: 'TWO FAMILY FRAME',
                                  B3: 'TWO FAMILY CONVERTED FROM ONE FAMILY',
                                  B9: 'MISCELLANEOUS TWO FAMILY',
                                  C0: 'THREE FAMILIES',
                                  C1: 'OVER SIX FAMILIES WITHOUT STORES',
                                  C2: 'FIVE TO SIX FAMILIES',
                                  C3: 'FOUR FAMILIES',
                                  C4: 'OLD LAW TENEMENT',
                                  C5: 'CONVERTED DWELLINGS OR ROOMING HOUSE',
                                  C6: 'WALK-UP COOPERATIVE',
                                  C7: 'WALK-UP APT. OVER SIX FAMILIES WITH STORES',
                                  C8: 'WALK-UP CO-OP; CONVERSION FROM LOFT/WAREHOUSE',
                                  C9: 'GARDEN APARTMENTS',
                                  CB: 'WALKUP APT LESS THAN 11 UNITS RESIDENTIAL',
                                  CC: 'WALKUP CO-OP APT LESS THAN 11 UNITS RESIDENTIAL',
                                  CM: 'MOBILE HOMES/TRAILER PARKS',
                                  D0: 'ELEVATOR CO-OP; CONVERSION FROM LOFT/WAREHOUSE',
                                  D1: 'ELEVATOR APT; SEMI-FIREPROOF WITHOUT STORES',
                                  D2: 'ELEVATOR APT; ARTISTS IN RESIDENCE',
                                  D3: 'ELEVATOR APT; FIREPROOF WITHOUT STORES',
                                  D4: 'ELEVATOR COOPERATIVE',
                                  D5: 'ELEVATOR APT; CONVERTED',
                                  D6: 'ELEVATOR APT; FIREPROOF WITH STORES',
                                  D7: 'ELEVATOR APT; SEMI-FIREPROOF WITH STORES',
                                  D8: 'ELEVATOR APT; LUXURY TYPE',
                                  D9: 'ELEVATOR APT; MISCELLANEOUS',
                                  DB: 'ELEVATOR APT LESS THAN 11 UNITS RESIDENTIAL',
                                  DC: 'ELEVATOR CO-OP APT LESS THAN 11 UNITS RESIDENTIAL',
                                  E1: 'GENERAL WAREHOUSE',
                                  E2: 'CONTRACTORS WAREHOUSE',
                                  E7: 'SELF-STORAGE WAREHOUSES',
                                  E9: 'MISCELLANEOUS WAREHOUSE',
                                  F1: 'FACTORY; HEAVY MANUFACTURING - FIREPROOF',
                                  F2: 'FACTORY; SPECIAL CONSTRUCTION - FIREPROOF',
                                  F4: 'FACTORY; INDUSTRIAL SEMI-FIREPROOF',
                                  F5: 'FACTORY; LIGHT MANUFACTURING',
                                  F8: 'FACTORY; TANK FARM',
                                  F9: 'FACTORY; INDUSTRIAL-MISCELLANEOUS',
                                  G0: 'GARAGE; RESIDENTIAL TAX CLASS 1',
                                  G1: 'ALL PARKING GARAGES',
                                  G2: 'AUTO BODY/COLLISION OR AUTO REPAIR',
                                  G3: 'GAS STATION WITH RETAIL STORE',
                                  G4: 'GAS STATION WITH SERVICE/AUTO REPAIR',
                                  G5: 'GAS STATION ONLY WITH/WITHOUT SMALL KIOSK',
                                  G6: 'LICENSED PARKING LOT',
                                  G7: 'UNLICENSED PARKING LOT',
                                  G8: 'CAR SALES/RENTAL WITH SHOWROOM',
                                  G9: 'MISCELLANEOUS GARAGE',
                                  GU: 'CAR SALES OR RENTAL LOTS WITHOUT SHOWROOM',
                                  GW: 'CAR WASH OR LUBRITORIUM FACILITY',
                                  HB: 'BOUTIQUE HOTEL: 10-100 ROOMS, W/LUXURY FACILITIES, THEMED, STYLISH, W/FULL SVC ACCOMMODATIONS',
                                  HH: 'HOSTELS- BED RENTALS IN DORMITORY-LIKE SETTINGS W/SHARED ROOMS & BATHROOMS',
                                  HR: 'SRO- 1 OR 2 PEOPLE HOUSED IN INDIVIDUAL ROOMS IN MULTIPLE DWELLING AFFORDABLE HOUSING',
                                  HS: 'EXTENDED STAY/SUITE: AMENITIES SIMILAR TO APT; TYPICALLY CHARGE WEEKLY RATES & LESS EXPENSIVE THAN FULL-SERVICE HOTEL',
                                  H1: 'LUXURY HOTEL',
                                  H2: 'FULL SERVICE HOTEL',
                                  H3: 'LIMITED SERVICE HOTEL; MANY AFFILIATED WITH NATIONAL CHAIN',
                                  H4: 'MOTEL',
                                  H5: 'HOTEL; PRIVATE CLUB, LUXURY TYPE',
                                  H6: 'APARTMENT HOTEL',
                                  H7: 'APARTMENT HOTEL - COOPERATIVELY OWNED',
                                  H8: 'DORMITORY',
                                  H9: 'MISCELLANEOUS HOTEL',
                                  I1: 'HOSPITAL, SANITARIUM, MENTAL INSTITUTION',
                                  I2: 'INFIRMARY',
                                  I3: 'DISPENSARY',
                                  I4: 'HOSPITAL; STAFF FACILITY',
                                  I5: 'HEALTH CENTER, CHILD CENTER, CLINIC',
                                  I6: 'NURSING HOME',
                                  I7: 'ADULT CARE FACILITY',
                                  I9: 'MISCELLANEOUS HOSPITAL, HEALTH CARE FACILITY',
                                  J1: 'THEATRE; ART TYPE LESS THAN 400 SEATS',
                                  J2: 'THEATRE; ART TYPE MORE THAN 400 SEATS',
                                  J3: 'MOTION PICTURE THEATRE WITH BALCONY',
                                  J4: 'LEGITIMATE THEATRE, SOLE USE',
                                  J5: 'THEATRE IN MIXED-USE BUILDING',
                                  J6: 'TELEVISION STUDIO',
                                  J7: 'OFF BROADWAY TYPE THEATRE',
                                  J8: 'MULTIPLEX PICTURE THEATRE',
                                  J9: 'MISCELLANEOUS THEATRE',
                                  K1: 'ONE STORY RETAIL BUILDING',
                                  K2: 'MULTI-STORY RETAIL BUILDING (2 OR MORE)',
                                  K3: 'MULTI-STORY DEPARTMENT STORE',
                                  K4: 'PREDOMINANT RETAIL WITH OTHER USES',
                                  K5: 'STAND-ALONE FOOD ESTABLISHMENT',
                                  K6: 'SHOPPING CENTER WITH OR WITHOUT PARKING',
                                  K7: 'BANKING FACILITIES WITH OR WITHOUT PARKING',
                                  K8: 'BIG BOX RETAIL: NOT AFFIXED & STANDING ON OWN LOT W/PARKING, E.G. COSTCO & BJS',
                                  K9: 'MISCELLANEOUS STORE BUILDING',
                                  L1: 'LOFT; OVER 8 STORIES (MID MANH. TYPE)',
                                  L2: 'LOFT; FIREPROOF AND STORAGE TYPE WITHOUT STORES',
                                  L3: 'LOFT; SEMI-FIREPROOF',
                                  L8: 'LOFT; WITH RETAIL STORES OTHER THAN TYPE ONE',
                                  L9: 'MISCELLANEOUS LOFT',
                                  M1: 'CHURCH, SYNAGOGUE, CHAPEL',
                                  M2: 'MISSION HOUSE (NON-RESIDENTIAL)',
                                  M3: 'PARSONAGE, RECTORY',
                                  M4: 'CONVENT',
                                  M9: 'MISCELLANEOUS RELIGIOUS FACILITY',
                                  N1: 'ASYLUM',
                                  N2: 'HOME FOR INDIGENT CHILDREN, AGED, HOMELESS',
                                  N3: 'ORPHANAGE',
                                  N4: 'DETENTION HOUSE FOR WAYWARD GIRLS',
                                  N9: 'MISCELLANEOUS ASYLUM, HOME',
                                  O1: 'OFFICE ONLY - 1 STORY',
                                  O2: 'OFFICE ONLY 2 - 6 STORIES',
                                  O3: 'OFFICE ONLY 7 - 19 STORIES',
                                  O4: 'OFFICE ONLY WITH OR WITHOUT COMM - 20 STORIES OR MORE',
                                  O5: 'OFFICE WITH COMM - 1 TO 6 STORIES',
                                  O6: 'OFFICE WITH COMM 7 - 19 STORIES',
                                  O7: 'PROFESSIONAL BUILDINGS/STAND ALONE FUNERAL HOMES',
                                  O8: 'OFFICE WITH APARTMENTS ONLY (NO COMM)',
                                  O9: 'MISCELLANEOUS AND OLD STYLE BANK BLDGS.',
                                  P1: 'CONCERT HALL',
                                  P2: 'LODGE ROOM',
                                  P3: 'YWCA, YMCA, YWHA, YMHA, PAL',
                                  P4: 'BEACH CLUB',
                                  P5: 'COMMUNITY CENTER',
                                  P6: 'AMUSEMENT PLACE, BATH HOUSE, BOAT HOUSE',
                                  P7: 'MUSEUM',
                                  P8: 'LIBRARY',
                                  P9: 'MISCELLANEOUS INDOOR PUBLIC ASSEMBLY',
                                  Q1: 'PARKS/RECREATION FACILTY',
                                  Q2: 'PLAYGROUND',
                                  Q3: 'OUTDOOR POOL',
                                  Q4: 'BEACH',
                                  Q5: 'GOLF COURSE',
                                  Q6: 'STADIUM, RACE TRACK, BASEBALL FIELD',
                                  Q7: 'TENNIS COURT',
                                  Q8: 'MARINA, YACHT CLUB',
                                  Q9: 'MISCELLANEOUS OUTDOOR RECREATIONAL FACILITY',
                                  RA: 'CONDO; CULTURAL, MEDICAL, EDUCATIONAL, ETC.',
                                  RB: 'CONDO; OFFICE SPACE',
                                  RG: 'CONDO; INDOOR PARKING',
                                  RH: 'CONDO; HOTEL/BOATEL',
                                  RK: 'CONDO; RETAIL SPACE',
                                  RP: 'CONDO; OUTDOOR PARKING',
                                  RR: 'CONDOMINIUM RENTALS',
                                  RS: 'CONDO; NON-BUSINESS STORAGE SPACE',
                                  RT: 'CONDO; TERRACES/GARDENS/CABANAS',
                                  RW: 'CONDO; WAREHOUSE/FACTORY/INDUSTRIAL',
                                  R0: 'SPECIAL CONDOMINIUM BILLING LOT',
                                  R1: 'CONDO; RESIDENTIAL UNIT IN 2-10 UNIT BLDG.',
                                  R2: 'CONDO; RESIDENTIAL UNIT IN WALK-UP BLDG.',
                                  R3: 'CONDO; RESIDENTIAL UNIT IN 1-3 STORY BLDG.',
                                  R4: 'CONDO; RESIDENTIAL UNIT IN ELEVATOR BLDG.',
                                  R5: 'CONDO; MISCELLANEOUS COMMERCIAL',
                                  R6: 'CONDO; RESID.UNIT OF 1-3 UNIT BLDG-ORIG CLASS 1',
                                  R7: 'CONDO; COMML.UNIT OF 1-3 UNIT BLDG-ORIG CLASS 1',
                                  R8: 'CONDO; COMML.UNIT OF 2-10 UNIT BLDG.',
                                  R9: 'CO-OP WITHIN A CONDOMINIUM',
                                  S0: 'PRIMARILY 1 FAMILY WITH 2 STORES OR OFFICES',
                                  S1: 'PRIMARILY 1 FAMILY WITH 1 STORE OR OFFICE',
                                  S2: 'PRIMARILY 2 FAMILY WITH 1 STORE OR OFFICE',
                                  S3: 'PRIMARILY 3 FAMILY WITH 1 STORE OR OFFICE',
                                  S4: 'PRIMARILY 4 FAMILY WITH 1 STORE OR OFFICE',
                                  S5: 'PRIMARILY 5-6 FAMILY WITH 1 STORE OR OFFICE',
                                  S9: 'SINGLE OR MULTIPLE DWELLING WITH STORES OR OFFICES',
                                  T1: 'AIRPORT, AIRFIELD, TERMINAL',
                                  T2: 'PIER, DOCK, BULKHEAD',
                                  T9: 'MISCELLANEOUS TRANSPORTATION FACILITY',
                                  U0: 'UTILITY COMPANY LAND AND BUILDING',
                                  U1: 'BRIDGE, TUNNEL, HIGHWAY',
                                  U2: 'GAS OR ELECTRIC UTILITY',
                                  U3: 'CEILING RAILROAD',
                                  U4: 'TELEPHONE UTILITY',
                                  U5: 'COMMUNICATION FACILITY OTHER THAN TELEPHONE',
                                  U6: 'RAILROAD - PRIVATE OWNERSHIP',
                                  U7: 'TRANSPORTATION - PUBLIC OWNERSHIP',
                                  U8: 'REVOCABLE CONSENT',
                                  U9: 'MISCELLANEOUS UTILITY PROPERTY',
                                  V0: 'ZONED RESIDENTIAL; NOT MANHATTAN',
                                  V1: 'ZONED COMMERCIAL OR MANHATTAN RESIDENTIAL',
                                  V2: 'ZONED COMMERCIAL ADJACENT TO CLASS 1 DWELLING: NOT MANHATTAN',
                                  V3: 'ZONED PRIMARILY RESIDENTIAL; NOT MANHATTAN',
                                  V4: 'POLICE OR FIRE DEPARTMENT',
                                  V5: 'SCHOOL SITE OR YARD',
                                  V6: 'LIBRARY, HOSPITAL OR MUSEUM',
                                  V7: 'PORT AUTHORITY OF NEW YORK AND NEW JERSEY',
                                  V8: 'NEW YORK STATE OR US GOVERNMENT',
                                  V9: 'MISCELLANEOUS VACANT LAND',
                                  W1: 'PUBLIC ELEMENTARY, JUNIOR OR SENIOR HIGH',
                                  W2: 'PAROCHIAL SCHOOL, YESHIVA',
                                  W3: 'SCHOOL OR ACADEMY',
                                  W4: 'TRAINING SCHOOL',
                                  W5: 'CITY UNIVERSITY',
                                  W6: 'OTHER COLLEGE AND UNIVERSITY',
                                  W7: 'THEOLOGICAL SEMINARY',
                                  W8: 'OTHER PRIVATE SCHOOL',
                                  W9: 'MISCELLANEOUS EDUCATIONAL FACILITY',
                                  Y1: 'FIRE DEPARTMENT',
                                  Y2: 'POLICE DEPARTMENT',
                                  Y3: 'PRISON, JAIL, HOUSE OF DETENTION',
                                  Y4: 'MILITARY AND NAVAL INSTALLATION',
                                  Y5: 'DEPARTMENT OF REAL ESTATE',
                                  Y6: 'DEPARTMENT OF SANITATION',
                                  Y7: 'DEPARTMENT OF PORTS AND TERMINALS',
                                  Y8: 'DEPARTMENT OF PUBLIC WORKS',
                                  Y9: 'DEPARTMENT OF ENVIRONMENTAL PROTECTION',
                                  Z0: 'TENNIS COURT, POOL, SHED, ETC.',
                                  Z1: 'COURT HOUSE',
                                  Z2: 'PUBLIC PARKING AREA',
                                  Z3: 'POST OFFICE',
                                  Z4: 'FOREIGN GOVERNMENT',
                                  Z5: 'UNITED NATIONS',
                                  Z7: 'EASEMENT',
                                  Z8: 'CEMETERY',
                                  Z9: 'OTHER MISCELLANEOUS'
                                };
        return buildingClasses[code] ?? 'Unknown building class ' + code;
    }

    let bcHtml = 'Not found';
    if (buildingClassMap.size === 1) {
        let bc = buildingClassMap.keys().next().value;
        bcHtml = '<abbr title="' + expandBuildingClass(bc) + '">' + bc + '</abbr>'
    } else if (buildingClassMap.size > 1) {
        /* Rare but possible for a single BIN to have multiple building class codes over time, eg 4554538.
           When this happens we'll list each followed by the most recent date it was used. */
        bcHtml = Array.from(buildingClassMap).map((x) => '<abbr title="' + expandBuildingClass(x[0]) + '">' + x[0] + '</abbr>' + ' (' + x[1] + ')').join(', ');
    }
    buildingClassDiv.innerHTML = '<strong>Building Class</strong> ' + bcHtml;
}

function clearIoElements() {
    addressDiv.innerHTML = '';
    binDiv.innerHTML = '';
    bblDiv.innerHTML = '';
    hpdDiv.innerHTML = '';
    buildingClassDiv.innerHTML = '';
    addressRangeList.innerHTML = '';
    const dobNowLink = document.getElementById('dobNowLink');
    if (dobNowLink) {
        dobNowLink.removeEventListener('mouseup', handleDobNowLinkEvents, {capture: true});
        dobNowLink.removeEventListener('click', handleDobNowLinkEvents, {capture: true});
    }
    infoTable.innerHTML = '';
}


/* LINK FUNCTIONS */

function constructUrlBisBrowse(boro, block, lot) {
    let url = 'https://a810-bisweb.nyc.gov/bisweb/PropertyBrowseByBBLServlet?allborough=' + boro + '&allblock=' + block;
    if (typeof lot !== 'undefined') {
        url += '&alllot=' + lot;
    }
    return url;
}

function constructUrlBisJobs(cBin, filler) {
    let url = 'https://a810-bisweb.nyc.gov/bisweb/JobsQueryByLocationServlet?allbin=' + cBin;
    if (typeof filler !== 'undefined') {
        url += '&fillerdata=' + filler;
    }
    return url;
}

function constructUrlBisProfileAddress(houseNumber, street, boroCode) {
    return 'https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?boro=' + boroCode + '&houseno=' + encodeURIComponent(houseNumber) + '&street=' + encodeURIComponent(street);
}

function constructUrlBisProfileBin(cBin) {
    return 'https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?bin=' + cBin;
}

function constructUrlGoat1A(houseNumber, street, boroCode) {
    return 'https://a030-goat.nyc.gov/goat/Function1A?borough=' + boroCode + '&street=' + encodeURIComponent(street) + '&address=' + encodeURIComponent(houseNumber);
}

function constructUrlGoatBN(cBin) {
    return 'https://a030-goat.nyc.gov/goat/FunctionBN?bin=' + cBin;
}

function constructUrlHpdId(hpdId) {
    return 'https://hpdonline.nyc.gov/hpdonline/building/' + hpdId + '/overview';
}

function constructUrlOverpassTurbo(cBin) {
    return 'https://overpass-turbo.eu/?Q=%7B%7BgeocodeArea%3Anyc%7D%7D-%3E.nyc%3B%0Anwr%5B%22nycdoitt%3Abin%22~' + cBin +  '%5D(area.nyc)%3B%0Aout%20geom%3B&R';
}

function constructUrlZolaLot(boro, block, lot) {
    return 'https://zola.planning.nyc.gov/l/lot/' + boro + '/' + block + '/' + lot;
}

async function handleDobNowLinkEvents(e) {
    e.preventDefault();
    if ((e.type === 'click') || ((e.button ?? 0) === 1)) {
        await navigator.clipboard.writeText(bin);
        if (e.type === 'click') {
            window.open(urlDobNow, 'dobNowTab-' + bin);
        }
    }
}


/* FOOTPRINT FUNCTIONS */

function processFootprint(footprintIndex, footprintBin, heightInMeters) {
    /* Digest a downloaded building footprint and add our own custom properties: A bounding box, an
    OSM XML representation of the footprint, and, for single-polygon buildings, a JOSM "add_way"
    remote control command. */

    function xmlTagList(tags) {
        xmlTags = '';
        for (const k in tags) {
            xmlTags += "    <tag k='" + k + "' v='" + tags[k] + "' />\r\n";
        }
        return xmlTags;
    }

    function xmlNodeListForPolygon(polygon, nodes) {
        let xmlNodes = '';
        for (const c of polygon) {
            xmlNodes += "    <nd ref='" + nodes[c[1] + "' lon='" + c[0]] + "' />\r\n";
        }
        return xmlNodes;
    }

    let footprint = footprintJson[footprintIndex];
    footprint.nycaabs_osm_xml = "<?xml version='1.0' encoding='UTF-8'?>\r\n<osm version='0.6' generator='NYCAABS'>\r\n";
    footprint.nycaabs_bbox_left = -73;
    footprint.nycaabs_bbox_right = -75;
    footprint.nycaabs_bbox_top = 40;
    footprint.nycaabs_bbox_bottom = 42;
    let elementCounter = -1;
    let nodeKey = '';
    const nodes = {};
    const tags = {building: 'yes'};
    tags['nycdoitt:bin'] = footprintBin;
    if (heightInMeters !== '') {
        tags['height'] = heightInMeters;
    }

    for (const polygon of footprint.the_geom.coordinates[0]) {
        for (const c of polygon) {
            //Round coordinates to OSM-standard 7 decimal digits
            c[0] = c[0].toFixed(7);
            c[1] = c[1].toFixed(7);
            footprint.nycaabs_bbox_left = Math.min(footprint.nycaabs_bbox_left, c[0]);
            footprint.nycaabs_bbox_right = Math.max(footprint.nycaabs_bbox_right, c[0]);
            footprint.nycaabs_bbox_top = Math.max(footprint.nycaabs_bbox_top, c[1]);
            footprint.nycaabs_bbox_bottom = Math.min(footprint.nycaabs_bbox_bottom, c[1]);
            nodeKey = c[1] + "' lon='" + c[0];
            //consider using a javascript map object with an array key instead of this hacky string key
            if (!(nodeKey in nodes)) {
                nodes[nodeKey] = elementCounter--;
            }
        }
    }

    for (const n in nodes) {
        //Add each node definition to the OSM XML
        footprint.nycaabs_osm_xml += "  <node id='" + nodes[n] + "' action='modify' visible='true' lat='" + n + "' />\r\n";
    }

    /* There are two different remote control commands that we can use to send a footprint to JOSM:
    "add_way" and "load_data". The "add_way" command can't handle multipolygon footprints (and
    there's no "add_relation" command) so we'll always use "load_data" for multipolygons, but for
    single-polygon footprints we'll use "add_way" because it has some advantages:
     - It only adds new nodes if neccessary, so JOSM will re-use any already loaded nodes at the
       same coordinates. This is convenient for connecting new footprints to previously-imported
       abuting footprints. Rarely it might also result in the new footprint connecting to non-
       building nodes, which could be problematic, but on balance this is still desired behavior.
       (In theory we could achieve similar behavior from "load_data" with a preliminary OSM API
       "map?bbox" call, swapping in the IDs of any existing nodes at the same locations.  Possibly
       a topic for further investigation.)
     - With "add_way", the new way and tags are recorded in JOSM's command stack, so can be undone
       (ctrl-Z) if desired. The "load_data" command doesn't give us that courtesy, so accidentally
       loading an incorrect footprint can leave your JOSM data layer in an awkward state.
    So, if the polygon count is 1, we'll add a "nycaabs_josm_add" property to the footprint for
    the sendFootprintToJosm function to find. If that property isn't found, sendFootprintToJosm
    will send the OSM XML version of the footprint via "load_data".
    */
    if (footprint.the_geom.coordinates[0].length === 1) {
        //Encode building footprint as a way
        footprint.nycaabs_osm_xml += "  <way id='" + elementCounter + "' action='modify' visible='true'>\r\n";
        footprint.nycaabs_osm_xml += xmlNodeListForPolygon(footprint.the_geom.coordinates[0][0], nodes);
        footprint.nycaabs_osm_xml += xmlTagList(tags);
        footprint.nycaabs_osm_xml += "  </way>\r\n";
        //Assemble the JOSM "add_way" remote control command
        footprint.nycaabs_josm_add = 'add_way?way=' + (footprint.the_geom.coordinates[0][0].map( x => x.reverse().join())).join(';') + '&addtags=' + (Object.entries(tags).map( t => t.join('='))).join('%7C');
    } else {
        //Encode building footprint as a multipolygon relation with an outer way and one or more inner ways
        let xmlRelationMembers = '';
        let role = 'outer';
        for (const polygon of footprint.the_geom.coordinates[0]) {
            xmlRelationMembers += "  <member type='way' ref='" + elementCounter + "' role='" + role + "' />\r\n";
            footprint.nycaabs_osm_xml += "  <way id='" + elementCounter-- + "' action='modify' visible='true'>\r\n";
            footprint.nycaabs_osm_xml += xmlNodeListForPolygon(polygon, nodes);
            footprint.nycaabs_osm_xml += "  </way>\r\n";
            role = 'inner';
        }
        footprint.nycaabs_osm_xml += "  <relation id='" + elementCounter + "' action='modify' visible='true'>\r\n";
        footprint.nycaabs_osm_xml += xmlRelationMembers;
        tags['type'] = 'multipolygon';
        footprint.nycaabs_osm_xml += xmlTagList(tags);
        footprint.nycaabs_osm_xml += "  </relation>\r\n";
    }
    footprint.nycaabs_osm_xml += "</osm>\r\n";
}

async function sendFootprintToJosm(footprintIndex) {
    //First, send a "load_and_zoom" command for surrounding context
    let loadAndZoomUrl = 'http://localhost:8111/load_and_zoom?left=' + (footprintJson[footprintIndex].nycaabs_bbox_left - 0.0005) + '&right=' + (footprintJson[footprintIndex].nycaabs_bbox_right + 0.0005) + '&top=' + (footprintJson[footprintIndex].nycaabs_bbox_top + 0.0004) + '&bottom=' + (footprintJson[footprintIndex].nycaabs_bbox_bottom - 0.0004);
    writeSearchLog('\r\nJOSM remote control command ' + loadAndZoomUrl + '\r\n');
    await fetch(loadAndZoomUrl);

    //Then send footprint with either "add_way" or "load_data" (see comments in processFootprint function)
    let sendFootprintUrl = 'http://localhost:8111/';
    if ('nycaabs_josm_add' in footprintJson[footprintIndex]) {
        sendFootprintUrl += footprintJson[footprintIndex].nycaabs_josm_add;
    } else {
        const regex = /\s\s+/g;
        sendFootprintUrl += 'load_data?data=' + encodeURIComponent(footprintJson[footprintIndex].nycaabs_osm_xml.replaceAll(regex, ''));
    }

    writeSearchLog('\r\nJOSM remote control command ' + sendFootprintUrl + '\r\n');
    let response = await fetch(sendFootprintUrl);

    //If the footprint delivery failed, retry once after one second
    if (!response.ok) {
        writeSearchLog('\r\n - retrying JOSM remote control command ' + sendFootprintUrl + '\r\n');
        setTimeout(() => { fetch(sendFootprintUrl); }, 1000);
    }
}


/* SLIPPY MAP FUNCTIONS */

function slippyMapInit() {
    let haveTileLayer = false;
    if (slippyMap === null) {
        slippyMap = L.map('slippyMapId',
                          {contextmenu: true,
                           contextmenuItems: [{
                             text: 'Search here',
                             callback: menuLatLonSearch
                           }, '-', {
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
                             text: 'Edit in RapiD',
                             callback: menuRapidEdit
                           }, {
                             text: 'Edit in JOSM',
                             callback: menuJosmEdit
                           }, '-', {
                             text: 'Cyclomedia imagery',
                             callback: menuCyclomedia
                           }, {
                             text: 'Bing Streetside imagery',
                             callback: menuBingStreetside
                           }, {
                             text: 'KartaView imagery',
                             callback: menuKartaView
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
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(slippyMap);
}


/* SLIPPY MAP CONTEXT MENU CALLBACK FUNCTIONS */

function menuLatLonSearch(e) {
    searchInput.value = e.latlng.lat + ' ' + e.latlng.lng
    doSearch();
}

function menuOsmView(e) {
    window.open('https://www.openstreetmap.org/#map=19/' + e.latlng.lat + '/' + e.latlng.lng, '_blank');
}

function menuOsmEdit(e) {
    window.open('https://www.openstreetmap.org/edit#map=19/' + e.latlng.lat + '/' + e.latlng.lng, '_blank');
}

function menuRapidEdit(e) {
    window.open('https://rapideditor.org/edit#map=19/' + e.latlng.lat + '/' + e.latlng.lng, '_blank');
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

async function menuKartaView(e) {
    const kvApiQuery = 'https://api.openstreetcam.org/2.0/photo/?lat=' + e.latlng.lat + '&lng=' + e.latlng.lng + '&zoomLevel=16&join=sequence&orderBy=id&orderDirection=desc';
    let kvJson = await httpGetJson(kvApiQuery, '"KartaView" latlon');
    let trackId = kvJson?.result?.data[0]?.sequence?.id ?? 0;
    let photoId = kvJson?.result?.data[0]?.sequenceIndex ?? 0;
    if (trackId > 0 && photoId > 0) { 
        window.open('https://kartaview.org/details/' + trackId + '/' + photoId + '/track-info', '_blank');
    } else {
        window.alert('no KartaView imagery found for this location')
    }
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


/* NETWORK FUNCTONS */

async function httpGetJson(getUrl, name) {
    writeSearchLog('\r\n' + name + ' query ' + getUrl + '\r\n');
    let responseJson = {};
    let errorMsg = '';
    try {
        const response = await fetch(getUrl);
        if (!response.ok) {
            writeSearchLog(' - Fetch response was not OK, status ' + response.status + ' "' + response.statusText + '"\r\n');
            errorMsg = 'Fetch response was not OK';
        }
        responseJson = await response.json();
        if (typeof(responseJson) !== 'undefined') {
            ['code', 'message', 'description'].forEach(warning => {
                if (typeof(responseJson[warning]) !== 'undefined') {
                    writeSearchLog(' - json "' + warning + '"="' + responseJson[warning] + '"\r\n');
                }
            });
        }
        if (errorMsg !== '') {
            throw new Error(errorMsg);
        }
    } catch (e) {
        writeSearchLog(' - ERROR: ' + (e.message ?? '') + '\r\n');
    }
    return responseJson;
}

async function httpHeadContentLength(headUrl) {
    let contentLength = 0;
    const response = await fetch(headUrl, {method: 'HEAD'});
    if (response.ok) {
        contentLength = Number(response.headers.get("content-length"));
    }
    return contentLength;
}

async function httpJosmRemoteControl(josmCommand) {
    const josmUrl = 'http://localhost:8111/' + josmCommand;
    writeSearchLog(' - JOSM command ' + josmUrl + '\r\n');
    try {
        const response = await fetch(josmUrl);
        if (response.ok) {
            return true;
        } else {
            writeSearchLog(' - JOSM response was not OK, status ' + response.status + ' "' + response.statusText + '"\r\n');
            throw new Error('JOSM response was not OK');
        }
    } catch (e) {
        writeSearchLog(' - ERROR: ' + (e.message ?? '') + '\r\n');
    }
    return false;
}


/* MISC FUNCTIONS */
//some of these might be better moved inside the relevant search functions

function validBin(testBin) {
    const reMatch = testBin.match(/^[1-5]([0-9]{6})$/);
    return (reMatch !== null) && (reMatch[1] !== '000000');
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