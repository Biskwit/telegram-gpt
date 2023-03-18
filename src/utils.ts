import * as fs from "fs";

const loadJSON = (filePath: string) => {
    if(fs.existsSync(filePath) == false) saveJSON(filePath, []);
    var json = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(json);
}

const saveJSON = (file: string, data:object) => {
    fs.writeFileSync(file, JSON.stringify(data))
}

export { loadJSON, saveJSON }