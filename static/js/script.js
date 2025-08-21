// Управление микрофоном
const micControl = document.getElementById('micControl');
let isMuted = true;

micControl.addEventListener('click', function() {
    isMuted = !isMuted;
    
    if (isMuted) {
        micControl.classList.add('muted');
        micControl.innerHTML = '<i class="fas fa-microphone-slash"></i>';
    } else {
        micControl.classList.remove('muted');
        micControl.innerHTML = '<i class="fas fa-microphone"></i>';
    }
});

// Инициализация состояния микрофона
micControl.classList.add('muted');

// Обработка отправки сообщения
document.querySelector('.send-btn').addEventListener('click', function() {
    const input = document.querySelector('.message-input input');
    if (input.value.trim() !== '') {
        // Здесь будет код отправки сообщения
        console.log('Отправлено сообщение:', input.value);
        input.value = '';
    }
});

// Отправка сообщения по Enter
document.querySelector('.message-input input').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
        document.querySelector('.send-btn').click();
    }
});