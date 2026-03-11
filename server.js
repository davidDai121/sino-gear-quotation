const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 8081;

const CAR_DICT = {
    "丰田": "Toyota", "本田": "Honda", "日产": "Nissan", "马自达": "Mazda", "三菱": "Mitsubishi",
    "斯巴鲁": "Subaru", "铃木": "Suzuki", "雷克萨斯": "Lexus", "英菲尼迪": "Infiniti", "讴歌": "Acura",
    "大众": "Volkswagen", "奥迪": "Audi", "宝马": "BMW", "奔驰": "Mercedes-Benz", "保时捷": "Porsche",
    "路虎": "Land Rover", "捷豹": "Jaguar", "沃尔沃": "Volvo", "特斯拉": "Tesla",
    "福特": "Ford", "雪佛兰": "Chevrolet", "别克": "Buick", "凯迪拉克": "Cadillac", "吉普": "Jeep",
    "现代": "Hyundai", "起亚": "Kia",
    "比亚迪": "BYD", "吉利": "Geely", "奇瑞": "Chery", "哈弗": "Haval", "长安": "Changan", 
    "五菱": "Wuling", "长城": "Great Wall", "红旗": "Hongqi", "蔚来": "NIO", "小鹏": "Xpeng", "理想": "Li Auto",

    "卡罗拉": "Corolla", "凯美瑞": "Camry", "亚洲龙": "Avalon", "雷凌": "Levin", "威驰": "Vios",
    "荣放": "RAV4", "汉兰达": "Highlander", "普拉多": "Prado", "兰德酷路泽": "Land Cruiser",
    "埃尔法": "Alphard", "威尔法": "Vellfire", "赛那": "Sienna", "皇冠": "Crown",

    "思域": "Civic", "雅阁": "Accord", "飞度": "Fit", "凌派": "Crider", "英诗派": "Inspire",
    "缤智": "Vezel", "皓影": "Breeze", "冠道": "Avancier", "奥德赛": "Odyssey", "艾力绅": "Elysion",
    "XR-V": "XR-V", "CR-V": "CR-V",

    "轩逸": "Sylphy", "天籁": "Altima", "骐达": "Tiida", "逍客": "Qashqai", "奇骏": "X-Trail", 
    "途达": "Terra", "楼兰": "Murano",

    "朗逸": "Lavida", "宝来": "Bora", "速腾": "Sagitar", "迈腾": "Magotan", "帕萨特": "Passat", 
    "高尔夫": "Golf", "途观": "Tiguan", "途昂": "Teramont", "途锐": "Touareg", "威然": "Viloran",
    "桑塔纳": "Santana", "捷达": "Jetta", "探岳": "Tayron",

    "自动挡": "Automatic",
    "手动挡": "Manual",
    "智能电混": "Intelligent Hybrid",
    "电混": "Hybrid",
    "智能": "Intelligent",
    "款": " Model", "自动": "Auto", "手动": "Manual", "手自一体": "Tiptronic",
    "双离合": "DCT", "无级": "CVT", "混动": "Hybrid", "双擎": "Hybrid", "插混": "PHEV", "纯电": "EV",
    "增程": "EREV", "两驱": "2WD", "四驱": "4WD", "全时四驱": "AWD",
    "涡轮增压": "Turbo", "自然吸气": "NA",
    "三厢": "Sedan", "两厢": "Hatchback", "旅行版": "Wagon", "轿跑": "Coupe", "敞篷": "Convertible",
    "SUV": "SUV", "MPV": "MPV",

    "版": " Edition", "型": " Type",
    "标准": "Standard", "舒适": "Comfort", "精英": "Elite", "豪华": "Luxury", "尊贵": "Premium", 
    "旗舰": "Flagship", "至尊": "Supreme", "顶配": "Top", "次顶配": "Sub-top",
    "时尚": "Fashion", "进取": "Progressive", "先锋": "Pioneer", "领先": "Leading", 
    "运动": "Sport", "智联": "Smart Connect", "互联": "Connected", "科技": "Tech", 
    "风尚": "Style", "智行": "Intelligent", "荣耀": "Glory", "悦享": "Joy", "畅享": "Enjoy",

    "车况好": "Good condition",
    "可过三方": "Third-party inspection ok",
    "4S店": "Authorized dealer",
    "4s店": "Authorized dealer",
    "无事故": "Accident-free", "原版原漆": "Original paint", "原漆": "Original paint",
    "一手": "First owner", "个人一手": "First private owner", "美女一手": "Lady driven (First owner)",
    "实表": "Actual mileage", "公里数少": "Low mileage", "调表": "Odometer rollback",
    "全程4S": "Full dealer service history", "记录完美": "Perfect service record",
    "发变巅峰": "Engine & Gearbox in peak condition", "巅峰状态": "Peak condition",
    "极品": "Excellent condition", "精品": "Premium condition", "车况": "Condition",
    "支持检测": "Inspection welcome", "第三方检测": "Third-party inspection",
    "费用遥远": "Long registration validity", "保险": "Insurance", "年检": "Inspection",
    "更换": "Replaced", "钣金": "Sheet metal repair", "喷漆": "Repainted", "补漆": "Touch-up paint",
    "划痕": "Scratches", "凹陷": "Dents", "瑕疵": "Flaws",
    "左": "Left", "右": "Right", "前": "Front", "后": "Rear", 
    "门": "Door", "翼子板": "Fender", "保险杠": "Bumper", "机盖": "Hood", "后备箱": "Trunk",
    "大灯": "Headlight", "尾灯": "Taillight", "玻璃": "Glass/Window", 
    "内饰": "Interior", "磨损": "Wear", "新": "New", "整洁": "Clean",
    "天窗": "Sunroof", "全景天窗": "Panoramic sunroof", "真皮座椅": "Leather seats", 
    "导航": "Navigation", "倒车影像": "Reverse camera", "雷达": "Parking sensors",
    "一键启动": "Push start", "无钥匙进入": "Keyless entry"
};

function translateText(text) {
    if (!text) return "";
    let result = text;
    const sortedKeys = Object.keys(CAR_DICT).sort((a, b) => b.length - a.length);
    
    for (const key of sortedKeys) {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escapedKey, 'g');
        result = result.replace(regex, " " + CAR_DICT[key] + " ");
    }
    
    return result.replace(/\s+/g, ' ').trim();
}

function translateJytData(data) {
    const translated = {};
    
    translated.name = translateText(data.name || "Unknown Model");
    
    const priceMatch = (data.price_label || "").match(/([\d.]+)万/);
    if (priceMatch) {
         translated.price = `¥${(parseFloat(priceMatch[1]) * 10000).toLocaleString()}`;
    } else {
        translated.price = data.price_label || "N/A";
    }
    
    const mileageMatch = (data.mileage_label || "").match(/([\d.]+)万公里/);
    if (mileageMatch) {
        translated.mileage = `${(parseFloat(mileageMatch[1]) * 10000).toLocaleString()} km`;
    } else {
        translated.mileage = data.mileage_label || "N/A";
    }
    
    let dateStr = data.plate_date_label || "N/A";
    dateStr = dateStr.replace("年", "");
    translated.plate_date = dateStr;
    
    translated.description = translateText(data.description || "");
    
    translated.images = (data.images || []).map(img => `https://img.jytche.com/${img.filename}`);
    
    return translated;
}

// JYT API Endpoint
app.get('/api/jyt-car', async (req, res) => {
    const link = req.query.link;
    if (!link) return res.status(400).json({ error: "Link is required" });

    try {
        const parsedUrl = new URL(link);
        const carCode = parsedUrl.searchParams.get('car_code');
        
        if (!carCode) {
            return res.status(400).json({ error: "Invalid link: car_code not found" });
        }

        const apiUrl = `https://inner-h5.jytche.com/inner-api/v2/car/${carCode}`;
        const accessToken = process.env.JYT_ACCESS_TOKEN;
        if (!accessToken) {
            return res.status(500).json({ error: "Server missing JYT_ACCESS_TOKEN" });
        }
        const headers = {
            "Access-Token": accessToken,
            "from-type": "h5",
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36"
        };

        const response = await axios.get(apiUrl, { headers });
        if (response.status !== 200) {
            return res.status(response.status).json({ error: "Failed to fetch data from JYT" });
        }

        const data = response.data;
        
        const processedData = translateJytData(data);
        
        res.json(processedData);

    } catch (error) {
        console.error("JYT Fetch Error:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Configure storage for multer
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // Ensure directory exists
        const dir = 'public/assets/';
        if (!fs.existsSync(dir)){
            fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
    },
    filename: function (req, file, cb) {
        // IMPORTANT: We need access to req.query here.
        // req.query is available because multer is called as middleware on the request.
        if (req.query.filename) {
            cb(null, req.query.filename);
        } else {
            cb(null, Date.now() + '-' + file.originalname);
        }
    }
});

const upload = multer({ storage: storage });

// Serve static files from public directory
app.use(express.static('public'));

// Upload endpoint
app.post('/upload', (req, res) => {
    // Multer middleware needs to run inside the route handler to catch errors
    // and access query params properly? No, it works as middleware.
    // Let's use upload.single('image') as middleware.
    
    const uploader = upload.single('image');
    uploader(req, res, function (err) {
        if (err instanceof multer.MulterError) {
            return res.status(500).json(err);
        } else if (err) {
            return res.status(500).json(err);
        }
        
        if (!req.file) {
            return res.status(400).send('No file uploaded.');
        }
        console.log(`File uploaded: ${req.file.filename}`);
        res.json({ success: true, filename: req.file.filename });
    });
});

app.get('/proxy-image', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) return res.status(400).send('URL required');

    try {
        const commonConfig = {
            url: imageUrl,
            method: 'GET',
            responseType: 'stream',
            maxRedirects: 5,
            validateStatus: (status) => status >= 200 && status < 300
        };

        let response;
        try {
            response = await axios({
                ...commonConfig,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': ''
                }
            });
        } catch (_) {
            response = await axios({
                ...commonConfig,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': 'https://h5.jytche.com/'
                }
            });
        }

        res.set('Content-Type', response.headers['content-type'] || 'application/octet-stream');
        response.data.pipe(res);
    } catch (error) {
        console.error('Proxy error:', error.message, 'URL:', imageUrl);
        res.redirect(imageUrl); 
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log('Use Ctrl+C to stop.');
});
