class GameLoop {
    constructor(tickRate, updateFn) {
        this.tickRate = tickRate;
        this.interval = 1000 / tickRate;
        this.updateFn = updateFn;
        this.timer = null;
        this.tick = 0;
    }

    start() {
        let lastTime = Date.now();
        this.timer = setInterval(() => {
            const now = Date.now();
            const deltaTime = (now - lastTime) / 1000;
            lastTime = now;
            this.tick++;
            this.updateFn(this.tick, deltaTime);
        }, this.interval);
        console.log(`GameLoop gestartet: ${this.tickRate} Ticks/Sek`);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
    }
}

module.exports = GameLoop;
