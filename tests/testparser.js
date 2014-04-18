var fs = require("fs");
var execute_parse = require('./parse.js').execute

function readText(path) {
    fs.readFile(path, function (err, data) {
        if (err) {
            console.log("ERROR READING:", err);
        } else {
            wiki_text = data;
            
            processText(wiki_text.toString());
        }
    });
}

function removeSectionToEnd(text, sectionTitle) {
    var re = new RegExp('==\\s?' + sectionTitle + '\\s?==[\s\S]*');
    match = re.exec(text);
    if (!match) {
        return text;
    } else {
        return text.substring(0, match.index);
    }
    
}

function processText(text) {
    sectionsToRemove = ['See also', 'References', 'External links', 'Further reading'];
    for (var i = 0; i < sectionsToRemove.length; i++) {
        text = removeSectionToEnd(text, sectionsToRemove[i]);
    }
    //console.log(text);
    execute_parse(text)
}

var text = readText('wikitext');

