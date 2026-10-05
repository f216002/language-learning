/* 語言學習：16 種語言配置＋提示辭產生器。
   提示辭以 ~/workspace/your_files/lang-learning-prompts.md 的印地文原版為準本，
   此處參數化產生（§三模板），R1–R5 改寫規則（2026-10-05 Cheng 已確認）。 */
var LL_LANGS = {
  hi: { code:'hi', name:'Hindi', nameZh:'印地文', locale:'hi-IN', scriptName:'天城文',
    requiresRomanization:true, cloudVoice:true,
    grammarFocus:'印地文的陰陽詞性、單複數、動詞變位', verbNote:null,
    examples:[
      { zh:'我想睡覺了。', foreign:'मुझे नींद आ रही है।', roman:'Mujhe neend aa rahi hai.' },
      { zh:'煮飯的時候。', foreign:'चावल बनाते समय।', roman:'Chaawal banaate samay.' },
      { zh:'開車的時候。', foreign:'गाड़ी चलाते समय।', roman:'Gaadi chalaate samay.' } ] },
  ne: { code:'ne', name:'Nepali', nameZh:'尼泊爾文', locale:'ne-NP', scriptName:'天城文',
    requiresRomanization:true, cloudVoice:true,
    grammarFocus:'尼泊爾文的敬語等級（तपाईं／तिमी／तँ 的區別與使用場合）、動詞的人稱一致、後置詞的用法', verbNote:null,
    examples:[
      { zh:'我想睡覺了。', foreign:'मलाई निद्रा लाग्यो।', roman:'Malai nidra lagyo.' },
      { zh:'煮飯的時候。', foreign:'खाना पकाउँदा।', roman:'Khana pakaunda.' },
      { zh:'開車的時候。', foreign:'गाडी चलाउँदा।', roman:'Gadi chalaunda.' } ] },
  bn: { code:'bn', name:'Bengali', nameZh:'孟加拉文', locale:'bn-BD', scriptName:'孟加拉文',
    requiresRomanization:true, cloudVoice:true,
    grammarFocus:'孟加拉文動詞的人稱時態變化、量詞的使用', verbNote:null,
    examples:[
      { zh:'我想睡覺了。', foreign:'আমার ঘুম পাচ্ছে।', roman:'Amar ghum pachchhe.' },
      { zh:'煮飯的時候。', foreign:'রান্না করার সময়।', roman:'Ranna karar samay.' },
      { zh:'開車的時候。', foreign:'গাড়ি চালানোর সময়।', roman:'Gari chalanor samay.' } ] },
  ta: { code:'ta', name:'Tamil', nameZh:'泰米爾文', locale:'ta-IN', scriptName:'泰米爾文',
    requiresRomanization:true, cloudVoice:true,
    grammarFocus:'泰米爾文的膠著語後綴、動詞的人稱性數一致、敬語的用法', verbNote:null,
    examples:[
      { zh:'我想睡覺了。', foreign:'எனக்கு தூக்கம் வருகிறது。', roman:'Enakku thookkam varugirathu.' },
      { zh:'煮飯的時候。', foreign:'சமைக்கும் போது。', roman:'Samaikkum pothu.' },
      { zh:'開車的時候。', foreign:'கார் ஓட்டும் போது。', roman:'Car ottum pothu.' } ] },
  si: { code:'si', name:'Sinhala', nameZh:'僧伽羅文', locale:'si-LK', scriptName:'僧伽羅文',
    requiresRomanization:true, cloudVoice:true,
    grammarFocus:'僧伽羅文的膠著語格後綴、敬語的用法、動詞的變化', verbNote:null,
    examples:[
      { zh:'我想睡覺了。', foreign:'මට නිදිමතයි.', roman:'Mata nidimatai.' },
      { zh:'煮飯的時候。', foreign:'උයන විට.', roman:'Uyana vita.' },
      { zh:'開車的時候。', foreign:'රිය පදවන විට.', roman:'Riya padavana vita.' } ] },
  th: { code:'th', name:'Thai', nameZh:'泰文', locale:'th-TH', scriptName:'泰文',
    requiresRomanization:true, cloudVoice:true,
    grammarFocus:'泰文的禮貌層級與語氣詞（ครับ／ค่ะ）、量詞的使用、句末助詞',
    verbNote:'泰文動詞不隨人稱時態變位，時態靠時間詞與助詞表達',
    examples:[
      { zh:'我想睡覺了。', foreign:'ฉันอยากนอนแล้ว。', roman:'Chan yak non laew.' },
      { zh:'煮飯的時候。', foreign:'ตอนทำอาหาร。', roman:'Ton tham aahan.' },
      { zh:'開車的時候。', foreign:'ตอนขับรถ。', roman:'Ton khap rot.' } ] },
  km: { code:'km', name:'Khmer', nameZh:'高棉文', locale:'km-KH', scriptName:'高棉文',
    requiresRomanization:true, cloudVoice:true,
    grammarFocus:'高棉文的量詞的使用、敬語的詞彙層次',
    verbNote:'高棉文動詞不隨人稱時態變化，時態靠時間詞表達',
    examples:[
      { zh:'我想睡覺了。', foreign:'ខ្ញុំចង់គេងហើយ.', roman:'Knhom chong keeng haey.' },
      { zh:'煮飯的時候。', foreign:'ពេលចម្អិនអាហារ.', roman:'Peel chamninh aahar.' },
      { zh:'開車的時候。', foreign:'ពេលបើកបរ.', roman:'Peel baek bar.' } ] },
  my: { code:'my', name:'Burmese', nameZh:'緬甸文', locale:'my-MM', scriptName:'緬甸文',
    requiresRomanization:true, cloudVoice:true,
    grammarFocus:'緬甸文的量詞的使用、敬語、句末助詞',
    verbNote:'緬甸文動詞不隨人稱時態變位，時態與禮貌靠句末助詞表達',
    examples:[
      { zh:'我想睡覺了。', foreign:'ကျွန်တော် အိပ်ချင်ပြီ.', roman:'Kyanaw aip ching pi.' },
      { zh:'煮飯的時候。', foreign:'ထမင်းချက်တဲ့အခါ.', roman:'Htamin chet tae a kha.' },
      { zh:'開車的時候。', foreign:'ကားမောင်းတဲ့အခါ.', roman:'Ka maung tae a kha.' } ] },
  vi: { code:'vi', name:'Vietnamese', nameZh:'越南文', locale:'vi-VN', scriptName:'越南文',
    requiresRomanization:false, cloudVoice:true,
    grammarFocus:'越南文的六個聲調、量詞的使用、人稱代詞的稱謂體系',
    verbNote:'越南文動詞不變位，時態與語氣靠助詞如 đã／đang／sẽ 表達',
    examples:[
      { zh:'我想睡覺了。', foreign:'Tôi muốn ngủ rồi.' },
      { zh:'煮飯的時候。', foreign:'Khi nấu cơm.' },
      { zh:'開車的時候。', foreign:'Khi lái xe.' } ] },
  id: { code:'id', name:'Indonesian', nameZh:'印尼文', locale:'id-ID', scriptName:'印尼文',
    requiresRomanization:false, cloudVoice:false,
    grammarFocus:'印尼文的詞綴系統、量詞的使用',
    verbNote:'印尼文動詞不隨人稱時態變化，意思靠詞綴如 me-／-kan、ber-、ter- 區別',
    examples:[
      { zh:'我想睡覺了。', foreign:'Saya ingin tidur.' },
      { zh:'煮飯的時候。', foreign:'Saat memasak.' },
      { zh:'開車的時候。', foreign:'Saat mengemudi.' } ] },
  es: { code:'es', name:'Spanish', nameZh:'西班牙文', locale:'es-ES', scriptName:'西班牙文',
    requiresRomanization:false, cloudVoice:false,
    grammarFocus:'西班牙文動詞的人稱時態變位、名詞與形容詞的性數一致、ser 與 estar 的區別', verbNote:null,
    examples:[
      { zh:'我想睡覺了。', foreign:'Tengo sueño.' },
      { zh:'煮飯的時候。', foreign:'Cuando cocino.' },
      { zh:'開車的時候。', foreign:'Cuando conduzco.' } ] },
  en: { code:'en', name:'English', nameZh:'英文', locale:'en-US', scriptName:'英文',
    requiresRomanization:false, cloudVoice:false,
    grammarFocus:'英文的時態體系、冠詞、介系詞（針對中文母語者的難點）', verbNote:null,
    examples:[
      { zh:'我想睡覺了。', foreign:'I feel sleepy now.' },
      { zh:'煮飯的時候。', foreign:'When cooking.' },
      { zh:'開車的時候。', foreign:'When driving.' } ] },
  de: { code:'de', name:'German', nameZh:'德文', locale:'de-DE', scriptName:'德文',
    requiresRomanization:false, cloudVoice:false,
    grammarFocus:'德文的性數格（陽性／陰性／中性×單複數×四格）、動詞的變位、框型句式', verbNote:null,
    examples:[
      { zh:'我想睡覺了。', foreign:'Ich bin schläfrig.' },
      { zh:'煮飯的時候。', foreign:'Beim Kochen.' },
      { zh:'開車的時候。', foreign:'Beim Autofahren.' } ] },
  ko: { code:'ko', name:'Korean', nameZh:'韓文', locale:'ko-KR', scriptName:'韓文',
    requiresRomanization:true, cloudVoice:false,
    grammarFocus:'韓文的敬語體系（합니다／해요）、助詞（은／는／이／가）、動詞語尾的變化', verbNote:null,
    examples:[
      { zh:'我想睡覺了。', foreign:'졸려요.', roman:'Jollyeoyo.' },
      { zh:'煮飯的時候。', foreign:'밥할 때.', roman:'Bap hal ttae.' },
      { zh:'開車的時候。', foreign:'운전할 때.', roman:'Unjeonhal ttae.' } ] },
  ja: { code:'ja', name:'Japanese', nameZh:'日文', locale:'ja-JP', scriptName:'日文',
    requiresRomanization:true, cloudVoice:false,
    grammarFocus:'日文的助詞（は／が／を／に）、動詞的ます形與辭書形、敬語（尊敬語／謙讓語）', verbNote:null,
    examples:[
      { zh:'我想睡覺了。', foreign:'眠くなってきました。', roman:'Nemuku natte kimashita.' },
      { zh:'煮飯的時候。', foreign:'ご飯を作るとき。', roman:'Gohan o tsukuru toki.' },
      { zh:'開車的時候。', foreign:'車を運転するとき。', roman:'Kuruma o unten suru toki.' } ] },
  fa: { code:'fa', name:'Persian', nameZh:'波斯文', locale:'fa-IR', scriptName:'波斯文',
    requiresRomanization:true, cloudVoice:true,
    grammarFocus:'波斯文動詞的人稱詞綴、ezāfe（ـِ）結構、時態', verbNote:null,
    examples:[
      { zh:'我想睡覺了。', foreign:'خوابم می‌آید.', roman:'Khaabam mi-aayad.' },
      { zh:'煮飯的時候。', foreign:'هنگام آشپزی.', roman:'Hengaam-e aashpazi.' },
      { zh:'開車的時候。', foreign:'هنگام رانندگی.', roman:'Hengaam-e raanandegi.' } ] }
};

/* 第一部分：學習提示辭（R1–R3）。 */
function llBuildLearnPrompt(code) {
  var L = LL_LANGS[code] || LL_LANGS.hi;
  var verb = L.verbNote
    ? '遇到單詞尤其是動詞，請詳細解釋它的用法（' + L.verbNote + '，請舉例說明之）'
    : '遇到單詞尤其是動詞的變化，請詳細解釋為什麼這樣變或者舉例說明之';
  var pron = L.requiresRomanization
    ? '那麼句子中，只要是有出現' + L.scriptName + '，請' + L.scriptName + '的後面一定要有括號,裡面附上羅馬拼音，幫助我理解。'
    : '那麼句子中，遇到發音特殊或容易讀錯的' + L.nameZh + '單詞，請在該單詞後面用括號附上發音提示，幫助我正確朗讀。';
  return '作為一位優秀的' + L.nameZh + '老師,請你解釋以下的' + L.nameZh +
    ',我是一位' + L.nameZh + '的初學習者,解釋的方法請用俄羅斯洋娃娃的剝洋蔥法，從大架構到小架構,逐層逐層分析它的語法架構還有每個單詞的使用。' +
    verb + '。還有，' + L.grammarFocus + '也都特別詳細說明。我是一個' + L.nameZh + '的初學者，你是一個優秀的' + L.nameZh + '老師。' +
    pron + '整個解釋請用中文來解釋，為了理解清楚,有時可以使用英文文法來輔助說明';
}

/* 第二部分：整理成句提示辭（R4–R5；格式即解析器契約）。 */
function llBuildOrganizePrompt(code) {
  var L = LL_LANGS[code] || LL_LANGS.hi;
  var foreignClause = L.requiresRomanization
    ? ',一句' + L.scriptName + '的' + L.nameZh + '語，然後一句羅馬拼音的' + L.nameZh + '語，還有一句'
    : '，一句' + L.nameZh + '文';
  var body = L.examples.map(function (ex, i) {
    var s = '第 ' + (i + 1) + ' 句\n\n中文：' + ex.zh + '\n' + L.scriptName + '：' + ex.foreign + '\n';
    if (L.requiresRomanization) s += '羅馬拼音：\n' + ex.roman + '\n' + ex.roman + '\n' + ex.roman + '\n';
    return s;
  }).join('');
  return '請整理以下的筆記，把它變成就是挑選出其中的' + L.nameZh + '的句子，把它變成這個中文翻譯' + foreignClause +
    '。至於解釋的部分就不用了，因為我要製作聲頻檔練習聽力還有說口說，所以我只需要完整的句子。那至於筆記裡面其他的解釋部分就把它刪除。整理好後請依照以下格式"' + body +
    '"重新輸出，原始筆記內容為:"請填入筆記內容"';
}

/* 解析第二部分格式的 AI 回答 → [{zh, foreign, roman}]。
   契約：以「第 N 句」切塊；欄位標記 中文：／｛文字名｝：／羅馬拼音：。 */
function llParseOrganizedText(text, code) {
  var L = LL_LANGS[code] || LL_LANGS.hi;
  var out = [];
  var blocks = String(text || '').split(/第\s*\d+\s*句/g).filter(function (b) { return b.trim().length > 0; });
  blocks.forEach(function (block) {
    var zhMatch = block.match(/中文[：:]\s*(.*?)(?=\n|$)/);
    var foreignLabel = L.scriptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var foreignRe = new RegExp(foreignLabel + '[：:]\\s*(.*?)(?=\\n|$)');
    var foreignMatch = block.match(foreignRe);
    var roMatch = block.match(/(?:羅馬拼音|拼音|音標)[：:]\s*([\s\S]*?)$/);
    var zh = zhMatch ? zhMatch[1].trim() : '';
    var foreign = foreignMatch ? foreignMatch[1].trim() : '';
    var roman = '';
    if (roMatch) {
      var lines = roMatch[1].trim().split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      roman = lines.length ? lines[0] : '';
    }
    if (zh || foreign) out.push({ zh: zh, foreign: foreign, roman: roman });
  });
  return out;
}
