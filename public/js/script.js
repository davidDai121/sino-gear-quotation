let currentImageTarget = null;
const fileInput = document.getElementById('file-input');
const colorPicker = document.getElementById('color-picker');
let activeColorElement = null;

document.addEventListener('DOMContentLoaded', () => {
    // Set current date
    const dateElement = document.getElementById('quotation-date');
    if (dateElement) {
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        dateElement.textContent = `DATE: ${year}.${month}.${day}`;
    }

    // Add delete buttons to existing items
    document.querySelectorAll('.card, .img-container').forEach(item => {
        addDeleteButton(item);
        if (item.classList.contains('img-container')) {
            enableDragAndDrop(item);
            addLabelControl(item);
        }
    });

    // Color Picker Logic
    document.addEventListener('click', function(e) {
        // Check if clicked element is color-editable
        // Specifically targeting img-label as requested, and potentially other text elements
        if (e.target.classList.contains('img-label')) {
            activeColorElement = e.target;
            const style = window.getComputedStyle(activeColorElement);
            colorPicker.value = rgbToHex(style.backgroundColor);
        } 
        else if (e.target.classList.contains('card-price') || e.target.classList.contains('main-title')) {
            activeColorElement = e.target;
            const style = window.getComputedStyle(activeColorElement);
            colorPicker.value = rgbToHex(style.color);
        }
    });

    colorPicker.addEventListener('input', function(e) {
        if (activeColorElement) {
            if (activeColorElement.classList.contains('img-label')) {
                 activeColorElement.style.backgroundColor = e.target.value;
            } else {
                 activeColorElement.style.color = e.target.value;
            }
        }
    });
});

function rgbToHex(rgb) {
    if (!rgb || rgb === 'rgba(0, 0, 0, 0)') return '#d81e06'; // Default red
    if (rgb.startsWith('#')) return rgb;
    const rgbValues = rgb.match(/\d+/g);
    if (!rgbValues) return '#000000';
    return "#" + 
        ("0" + parseInt(rgbValues[0], 10).toString(16)).slice(-2) +
        ("0" + parseInt(rgbValues[1], 10).toString(16)).slice(-2) +
        ("0" + parseInt(rgbValues[2], 10).toString(16)).slice(-2);
}

function addDeleteButton(element) {
    if (element.querySelector('.delete-btn')) return;

    const btn = document.createElement('div');
    btn.className = 'delete-btn';
    btn.innerHTML = '<i class="fas fa-times"></i>';
    btn.title = 'Remove Item';
    btn.onclick = function(e) {
        e.stopPropagation();
        element.remove();
    };
    element.appendChild(btn);
}

function addCard(container) {
    if (!container) return;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
        <div class="card-title" contenteditable="true">NEW CAR MODEL</div>
        <div class="card-detail" contenteditable="true">
            ENERGY: PURE GASOLINE<br>
            ENGINE: 1.5L 115 HP L4
        </div>
        <div class="card-price" contenteditable="true">PRICE: $0</div>
    `;
    addDeleteButton(card);
    container.appendChild(card);
}

function addImageSlot(container) {
    if (!container) return;
    const slot = document.createElement('div');
    slot.className = 'img-container';
    slot.setAttribute('onclick', "triggerUpload(this.querySelector('img'))");
    slot.innerHTML = `
        <img src="https://placehold.co/600x400?text=New+Image" alt="Car Image">
    `;
    addDeleteButton(slot);
    enableDragAndDrop(slot);
    addLabelControl(slot);
    container.appendChild(slot);
}

function addLabelControl(container) {
    if (!container) return;
    
    // Check if label exists
    const label = container.querySelector('.img-label');
    if (label) {
        addDeleteLabelButton(label);
    } else {
        addCreateLabelButton(container);
    }
}

function addCreateLabelButton(container) {
    // Remove any existing add-label-btn first to avoid duplicates
    const existingBtn = container.querySelector('.add-label-btn');
    if (existingBtn) existingBtn.remove();

    const btn = document.createElement('div');
    btn.className = 'add-label-btn';
    btn.innerHTML = '<i class="fas fa-tag"></i>';
    btn.title = 'Add Label';
    btn.onclick = function(e) {
        e.stopPropagation();
        // Create label
        const label = document.createElement('div');
        label.className = 'img-label';
        label.contentEditable = true;
        label.setAttribute('onclick', 'event.stopPropagation()');
        label.innerText = 'LABEL';
        container.insertBefore(label, container.firstChild);
        
        // Switch to delete button
        addDeleteLabelButton(label);
    };
    container.appendChild(btn);
}

function addDeleteLabelButton(label) {
    const container = label.parentElement;
    // Remove any existing add-label-btn
    const existingBtn = container.querySelector('.add-label-btn');
    if (existingBtn) existingBtn.remove();
    
    const btn = document.createElement('div');
    btn.className = 'add-label-btn';
    btn.innerHTML = '<i class="fas fa-minus"></i>';
    btn.title = 'Remove Label';
    btn.onclick = function(e) {
        e.stopPropagation();
        label.remove();
        addCreateLabelButton(container);
    };
    container.appendChild(btn);
}

function enableDragAndDrop(element) {
    if (!element) return;
    
    // Check if element is a container or if we need to find the container
    const container = element.classList.contains('img-container') ? element : element.closest('.img-container');
    if (!container) return;

    // Prevent default behaviors for drag events
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        container.addEventListener(eventName, preventDefaults, false);
    });

    // Highlight drop area when item is dragged over it
    ['dragenter', 'dragover'].forEach(eventName => {
        container.addEventListener(eventName, () => container.classList.add('highlight'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        container.addEventListener(eventName, () => container.classList.remove('highlight'), false);
    });

    // Handle dropped files
    container.addEventListener('drop', (e) => {
        preventDefaults(e);
        container.classList.remove('highlight');
        handleDrop(e);
    }, false);
}

// Global paste event listener
document.addEventListener('paste', function(e) {
    // Only handle paste if no specific element is focused or if body is focused
    if (document.activeElement !== document.body && document.activeElement.getAttribute('contenteditable') === 'true') {
        return; // Allow default paste behavior in contenteditable elements
    }

    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    let blob = null;

    // Find image in clipboard items
    for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
            blob = items[i].getAsFile();
            break;
        }
    }

    if (blob) {
        if (!currentImageTarget) {
            alert('Please click on an image slot first to activate it for pasting.');
            return;
        }

        const reader = new FileReader();
        reader.onload = function(event) {
            currentImageTarget.src = event.target.result;
            // Clear error handler
            currentImageTarget.onerror = null;
            currentImageTarget.onclick = function() { triggerUpload(this); };
        };
        reader.readAsDataURL(blob);

        // Upload if it's logo or qr code
        const isLogo = currentImageTarget.classList.contains('logo-img');
        const isWeChat = currentImageTarget.alt === 'WeChat';
        const isWhatsApp = currentImageTarget.alt === 'WhatsApp';
        
        let filename = null;
        if (isLogo) filename = '二手车图文报价.png';
        if (isWeChat) filename = 'Wechat QR.png';
        if (isWhatsApp) filename = 'WhatsApp QR.png';

        if (filename) {
            const formData = new FormData();
            formData.append('image', blob); // blob is the file
            
            fetch(`/upload?filename=${encodeURIComponent(filename)}`, {
                method: 'POST',
                body: formData
            })
            .then(response => response.json())
            .then(data => {
                if(data.success) console.log('Image uploaded via paste: ' + filename);
            })
            .catch(err => console.error(err));
        }
        
        e.preventDefault(); 
    }
});

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

function handleDrop(e) {
    const dt = e.dataTransfer;
    const container = e.currentTarget;
    const imgElement = container.querySelector('img');

    if (!imgElement) return;

    // 1. Local Files
    if (dt.files && dt.files.length > 0) {
        handleFiles(dt.files, imgElement);
        return;
    }

    // 2. Image URL (Dragging from web)
    const url = dt.getData('URL') || dt.getData('text/uri-list');
    if (url) {
        // If it's a remote URL, use proxy to avoid CORS/Hotlink issues
        if (url.startsWith('http') && !url.includes(window.location.host)) {
            imgElement.src = `/proxy-image?url=${encodeURIComponent(url)}`;
        } else {
            imgElement.src = url;
        }
        // Also clear error handler if it was set
        imgElement.onerror = null;
        imgElement.onclick = function() { triggerUpload(this); };
        return;
    }
    
    // 3. HTML (Sometimes URL is not direct)
    const html = dt.getData('text/html');
    if (html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const src = doc.querySelector('img')?.src;
        if (src) {
            // Check if src is remote
            if (src.startsWith('http') && !src.includes(window.location.host)) {
                imgElement.src = `/proxy-image?url=${encodeURIComponent(src)}`;
            } else {
                imgElement.src = src;
            }
            imgElement.onerror = null;
            imgElement.onclick = function() { triggerUpload(this); };
            return;
        }
    }
}

function handleFiles(files, imgElement) {
    const file = files[0];
    if (file && file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = function(e) {
            imgElement.src = e.target.result;
        };
        reader.readAsDataURL(file);
    }
}

// 触发图片上传
function triggerUpload(imgElement) {
    if (!imgElement) return;
    currentImageTarget = imgElement;
    fileInput.click();
}

// 处理图片选中并替换
fileInput.addEventListener('change', function(event) {
    const file = event.target.files[0];
    if (file && currentImageTarget) {
        
        // 立即在前端显示
        const reader = new FileReader();
        reader.onload = function(e) {
            currentImageTarget.src = e.target.result;
            // 清除可能存在的错误处理，并恢复点击事件
            currentImageTarget.onerror = null; 
            currentImageTarget.onclick = function() { triggerUpload(this); };
        };
        reader.readAsDataURL(file);

        // 如果图片是 logo 或二维码，尝试上传并覆盖服务器文件
        const isLogo = currentImageTarget.classList.contains('logo-img');
        const isWeChat = currentImageTarget.alt === 'WeChat';
        const isWhatsApp = currentImageTarget.alt === 'WhatsApp';
        
        let filename = null;
        if (isLogo) filename = '二手车图文报价.png';
        if (isWeChat) filename = 'Wechat QR.png';
        if (isWhatsApp) filename = 'WhatsApp QR.png';

        if (filename) {
            const formData = new FormData();
            formData.append('image', file);
            
            fetch(`/upload?filename=${encodeURIComponent(filename)}`, {
                method: 'POST',
                body: formData
            })
            .then(response => response.json())
            .then(data => {
                if(data.success) {
                    console.log('Image uploaded and saved as ' + filename);
                    // 上传成功后，我们不需要重新设置 src，因为 FileReader 已经显示了图片
                    // 下次刷新页面时，会自动加载 assets 下的新图片
                } else {
                    console.error('Upload failed');
                }
            })
            .catch(error => console.error('Error uploading image:', error));
        }
    }
    fileInput.value = '';
});

// 导出 PDF 逻辑
function exportPDF() {
    const element = document.getElementById('quotation-content');
    document.body.classList.add('exporting');
    
    // 配置 PDF 导出选项
    const opt = {
        margin:       0,
        filename:     'SinoGear-Quotation.pdf',
        image:        { type: 'jpeg', quality: 0.98 },
        html2canvas:  { scale: 2, useCORS: true }, 
        jsPDF:        { unit: 'px', format: [794, 1123], orientation: 'portrait' },
        pagebreak:    { mode: ['css', 'legacy'] }
    };

    // 生成 PDF
    html2pdf().set(opt).from(element).save().then(() => {
        document.body.classList.remove('exporting');
    }).catch(err => {
        console.error(err);
        document.body.classList.remove('exporting');
    });
}
