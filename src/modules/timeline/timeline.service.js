
const mergeTimeline = (calendarActivities = [], driveActivities = []) => {
    const normalizedDrive = driveActivities.map(activity => {
        if(!activity.endTime) {
            const startTime = new Date(activity.startTime);
            const endTime = new Date(startTime.getTime() + 15 * 60000);
            return { ...activity,
                endTime: endTime.toISOString()
            };
        }
        return activity;
    }) ;

    const allActivities = [...calendarActivities, ...normalizedDrive];

    return allActivities.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
}


const isSafeDomain = (urlString, targetDomain) => {
    if (!urlString) return false;
    try {
        const url = new URL(urlString);
        return url.hostname === targetDomain || url.hostname.endsWith(`.${targetDomain}`);
    } catch  {
        return false;
    }



};


const groupByApp = (activities = []) => {
    const grouped = {
        Meet: [],
        Docs: [],
        Sheets: [],
        Drive: [],
        Calendar: []
    };

    activities.forEach(activity => {
        const source = (activity.source || '').toLowerCase();
        const metadata = activity.metadata_json || {};
        const link = (metadata.link || '').toLowerCase();
        const mimeType = (metadata.mimeType || '').toLowerCase();
        const title = (activity.title || '').toLowerCase();



    if (source === 'calendar') {
        if (isSafeDomain(link, 'meet.google.com') || title.includes('meet')) {
            grouped.Meet.push(activity);

        } else {
            grouped.Calendar.push(activity);
        }
    }
    else if (source === 'drive') {
        if (mimeType.includes('document') || isSafeDomain(link, 'docs.google.com')) {
            grouped.Docs.push(activity);
        } else if (mimeType.includes('spreadsheet') || isSafeDomain(link, 'sheets.google.com')) {
            grouped.Sheets.push(activity);
        } else {
            grouped.Drive.push(activity);
        }
    }
    });

    return grouped;
}

module.exports = {
    mergeTimeline,
    groupByApp,
}