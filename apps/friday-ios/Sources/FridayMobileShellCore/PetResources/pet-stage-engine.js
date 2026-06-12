(function(){
  "use strict";

  var CORE_VERSION = "anchor-prototype-20260605-9";
  var ECO_VERSION = "anchor-prototype-20260605-eco-anim-v4-32";
  var CORE_NAMES = ["idle","sit","walk","run","happy","beg","play","dance","sleep","back"];
  var ECO_ALPHA = "/source/pet/generated/ecology-anim-v4/alpha/";
  var ECO_TAXONOMY = "/source/pet/generated/ecology-anim-v4/action-taxonomy.json";
  var CORE_RATIO_BASE = 140 * 2 * .96;
  var INTERNAL_TO_CSS = .5;
  var SAFE_CANVAS_MARGIN = 36;
  var CARD_EDGE_MARGIN = 10;
  var FOOTLINE = .94;
  var BOTTOM_GAP = 14;
  var DEFAULT_ECO_ALLOWLIST = [];

  var packPromises = {};

  function clamp(v){ return Math.max(0, Math.min(1, v)); }
  function median(vals){
    vals = vals.slice().sort(function(a,b){ return a - b; });
    var m = Math.floor(vals.length / 2);
    return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
  }
  function fetchJson(url){ return fetch(url).then(function(r){ if(!r.ok) throw new Error(url); return r.json(); }); }
  function loadImage(url){
    return new Promise(function(resolve, reject){
      var img = new Image();
      img.onload = function(){ resolve(img); };
      img.onerror = reject;
      img.src = url;
    });
  }
  function coreId(name){ return "core:" + name; }
  function ecoId(name){ return "eco:" + name; }
  function splitId(id){
    var ix = id.indexOf(":");
    return ix < 0 ? { pack: "core", name: id } : { pack: id.slice(0, ix), name: id.slice(ix + 1) };
  }

  function packConfig(options){
    options = options || {};
    var ecoAlpha = options.ecoAlpha || ECO_ALPHA;
    if(ecoAlpha.charAt(ecoAlpha.length - 1) !== "/") ecoAlpha += "/";
    return {
      coreVersion: options.coreVersion || CORE_VERSION,
      ecoVersion: options.ecoVersion || ECO_VERSION,
      ecoAlpha: ecoAlpha,
      ecoTaxonomy: options.ecoTaxonomy || ECO_TAXONOMY
    };
  }

  function loadPack(options){
    var cfg = packConfig(options);
    var key = [cfg.coreVersion, cfg.ecoVersion, cfg.ecoAlpha, cfg.ecoTaxonomy].join("|");
    if(packPromises[key]) return packPromises[key];
    packPromises[key] = Promise.all([
      fetchJson("/source/pet/green-manifest.json?v=" + cfg.coreVersion),
      fetchJson(cfg.ecoAlpha + "ecology-anim-manifest.json?v=" + cfg.ecoVersion),
      fetchJson(cfg.ecoTaxonomy + "?v=" + cfg.ecoVersion)
    ]).then(function(parts){
      var core = parts[0], eco = parts[1], taxonomy = parts[2], images = {};
      var jobs = [];
      CORE_NAMES.forEach(function(name){
        jobs.push(loadImage("/source/pet/g-" + name + ".png?v=" + cfg.coreVersion).then(function(img){
          images[coreId(name)] = img;
        }));
      });
      Object.keys(eco.clips || {}).forEach(function(name){
        var clip = eco.clips[name];
        var path = clip.image ? "/" + clip.image.replace(/^\/+/, "") : cfg.ecoAlpha + "g-eco-" + name + ".png";
        jobs.push(loadImage(path + "?v=" + cfg.ecoVersion).then(function(img){
          images[ecoId(name)] = img;
        }));
      });
      return Promise.all(jobs).then(function(){
        return { core: core, eco: eco, taxonomy: taxonomy, images: images };
      });
    });
    return packPromises[key];
  }

  function createStage(el, options){
    options = options || {};
    return loadPack(options).then(function(pack){
      return new PetRuntime(el, options, pack);
    });
  }

  function PetRuntime(stage, options, pack){
    this.stage = stage;
    this.options = options || {};
    this.pack = pack;
    this.surface = options.surface || "mobile";
    this.height = options.height || stage.clientHeight || 155;
    this.visualAW = options.visualAW || 150;
    this.CS = this.visualAW * 2;
    this.autoSchedule = options.autoSchedule !== false;
    this.interactive = options.interactive !== false;
    this.refH = pack.core.refH || 328;
    this.coreScaleCache = {};
    this.ecoScale = 1;
    this.ecoAllowlist = {};
    (options.ecoAllowlist || DEFAULT_ECO_ALLOWLIST).forEach(function(name){
      this.ecoAllowlist[name] = true;
    }, this);
    this.actor = document.createElement("div");
    this.actor.className = "friday-pet-actor";
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d");
    this.fx = document.createElement("div");
    this.fx.className = "friday-pet-fx";
    this.actor.appendChild(this.canvas);
    this.actor.appendChild(this.fx);
    this.stage.appendChild(this.actor);

    this.dead = false;
    this.cur = coreId("idle");
    this.frame = 0;
    this.frameAcc = 0;
    this.lastTs = 0;
    this.lifeT = 0;
    this.lastTouchT = 0;
    this.footX = (stage.clientWidth || 320) * .5;
    this.targetX = this.footX;
    this.vx = 0;
    this.faceDir = 1;
    this.mode = "base";
    this.loops = 1;
    this.queue = [];
    this.restTimer = 0;
    this.sleepHold = false;
    this.beatT = null;
    this.layout = null;
    this.minFoot = this.footX;
    this.maxFoot = this.footX;
    this.lastActionAt = {};
    this.soul = { energy: .58, curiosity: .56, affection: .62, sleepiness: .14, reason: "settling_in", history: [] };

    this.setupScales();
    this.applyLayout();
    this.attach();
    this.start(coreId("idle"), { loops: 5, reason: "settling_in" });
    requestAnimationFrame(this.tick.bind(this));
    if(this.autoSchedule) this.schedule();
  }

  PetRuntime.prototype.clip = function(id){
    var s = splitId(id);
    return s.pack === "eco" ? this.pack.eco.clips[s.name] : this.pack.core.clips[s.name];
  };
  PetRuntime.prototype.img = function(id){ return this.pack.images[id]; };
  PetRuntime.prototype.isEco = function(id){ return id.indexOf("eco:") === 0; };
  PetRuntime.prototype.isCore = function(id){ return id.indexOf("core:") === 0; };
  PetRuntime.prototype.roleOf = function(id){
    if(this.isEco(id)) return (this.clip(id) || {}).role || "eco";
    var s = splitId(id);
    var meta = ((this.clip(id) || {}).meta || {});
    if(s.name === "walk" || s.name === "run") return "move";
    return meta.role || "core";
  };
  PetRuntime.prototype.isEcoLoco = function(id){
    return id === ecoId("roam-step-left") || id === ecoId("roam-step-right");
  };
  PetRuntime.prototype.isDirectional = function(id){
    return id === coreId("walk") || id === coreId("run") || this.isEcoLoco(id);
  };
  PetRuntime.prototype.isCoreBase = function(id){ return id === coreId("idle") || id === coreId("sit"); };
  PetRuntime.prototype.isSleepLoop = function(id){ return id === ecoId("sleep-curl-zzz") || id === ecoId("sleep-side-breathe"); };
  PetRuntime.prototype.isEcoAllowed = function(name){
    return !!this.ecoAllowlist[name];
  };
  PetRuntime.prototype.allowedEcoNames = function(){
    var self = this;
    return Object.keys(this.pack.eco.clips || {}).filter(function(name){
      return self.isEcoAllowed(name);
    });
  };
  PetRuntime.prototype.hasAllowedEco = function(){
    return this.allowedEcoNames().length > 0;
  };
  PetRuntime.prototype.hasAllowedEcoSleep = function(){
    return this.isEcoAllowed("rest-stretch-down") && (this.isEcoAllowed("sleep-curl-zzz") || this.isEcoAllowed("sleep-side-breathe"));
  };

  PetRuntime.prototype.avgContentH = function(id){
    var c = this.clip(id), sum = 0, n = 0;
    if(!c) return this.refH;
    (c.anchors || []).forEach(function(a){ if(a.contentRect){ sum += a.contentRect[3]; n += 1; } });
    return n ? sum / n : this.refH;
  };
  PetRuntime.prototype.avgCoreH = function(names){
    var self = this, vals = [];
    names.forEach(function(name){
      var c = self.pack.core.clips[name];
      if(!c) return;
      (c.anchors || []).forEach(function(a){ if(a.contentRect) vals.push(a.contentRect[3]); });
    });
    return vals.length ? vals.reduce(function(a,b){ return a + b; }, 0) / vals.length : 272;
  };
  PetRuntime.prototype.ecoRefH = function(){
    var self = this;
    var refs = ["sit-wait","sit-head-tilt","sit-paw-lift","curious-look-left-right","mood-shy-blink","mood-surprised","happy-tail-wag"];
    var vals = [];
    refs.forEach(function(name){
      var c = self.pack.eco.clips[name];
      if(!c) return;
      (c.anchors || []).forEach(function(a){
        var r = a.contentRect;
        if(r && r[3] > 170 && r[3] < 230) vals.push(r[3]);
      });
    });
    return vals.length ? median(vals) : 208;
  };
  PetRuntime.prototype.setupScales = function(){
    var coreDisplayInternal = this.avgCoreH(["sit","idle","happy"]) * (CORE_RATIO_BASE / this.refH);
    this.ecoScale = coreDisplayInternal / this.ecoRefH();
  };
  PetRuntime.prototype.coreActionScale = function(name){
    if(this.coreScaleCache[name]) return this.coreScaleCache[name];
    var sitH = this.avgContentH(coreId("sit"));
    var h = this.avgContentH(coreId(name));
    this.coreScaleCache[name] = Math.max(.92, Math.min(1.75, sitH / h));
    return this.coreScaleCache[name];
  };
  PetRuntime.prototype.ratioFor = function(id){
    if(this.isEco(id)){
      var derivedCore = (this.clip(id) || {}).derivedCore;
      if(derivedCore) return (CORE_RATIO_BASE / this.refH) * this.coreActionScale(derivedCore);
      return this.ecoScale;
    }
    return (CORE_RATIO_BASE / this.refH) * this.coreActionScale(splitId(id).name);
  };
  PetRuntime.prototype.actions = function(){
    var out = CORE_NAMES.map(coreId);
    this.allowedEcoNames().forEach(function(name){ out.push(ecoId(name)); });
    return out;
  };
  PetRuntime.prototype.anchorFor = function(id, frameIndex){
    var c = this.clip(id);
    var f = c.frames[frameIndex];
    var a = (c.anchors && c.anchors[frameIndex]) || { ax: f[2] / 2, ay: f[3] - 1 };
    var r = a.contentRect || [0, 0, f[2], f[3]];
    var anchorX;
    if(this.isEco(id)){
      anchorX = (a.drawAx == null ? f[2] / 2 : a.drawAx) - r[0];
      var ecoAy = a.drawAy == null ? a.ay : a.drawAy;
      return { frame: f, anchor: a, rect: r, anchorX: anchorX, anchorY: ecoAy - r[1] };
    } else {
      anchorX = (a.drawAx == null ? a.ax - r[0] : a.drawAx);
    }
    var anchorY = (a.drawAy == null ? a.ay - r[1] : a.drawAy);
    return { frame: f, anchor: a, rect: r, anchorX: anchorX, anchorY: anchorY };
  };
  PetRuntime.prototype.rawBounds = function(id, frameIndex){
    var m = this.anchorFor(id, frameIndex);
    var ratio = this.ratioFor(id);
    var baseline = this.CS * FOOTLINE;
    var dx = this.CS / 2 - m.anchorX * ratio;
    var dy = baseline - m.anchorY * ratio;
    return { left: dx, top: dy, right: dx + m.rect[2] * ratio, bottom: dy + m.rect[3] * ratio };
  };
  PetRuntime.prototype.computeLayout = function(){
    var W = this.stage.clientWidth || 320;
    var H = this.stage.clientHeight || this.height;
    var raw = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    var self = this;
    this.actions().forEach(function(id){
      var c = self.clip(id);
      if(!c) return;
      for(var i = 0; i < c.frames.length; i += 1){
        var b = self.rawBounds(id, i);
        raw.left = Math.min(raw.left, b.left);
        raw.top = Math.min(raw.top, b.top);
        raw.right = Math.max(raw.right, b.right);
        raw.bottom = Math.max(raw.bottom, b.bottom);
      }
    });
    if(!isFinite(raw.left)) raw = { left: 0, top: 0, right: this.CS, bottom: this.CS };
    var offsetX = SAFE_CANVAS_MARGIN - raw.left;
    var offsetY = SAFE_CANVAS_MARGIN - raw.top;
    var canvasW = Math.ceil(raw.right - raw.left + SAFE_CANVAS_MARGIN * 2);
    var canvasH = Math.ceil(raw.bottom - raw.top + SAFE_CANVAS_MARGIN * 2);
    var cssW = Math.ceil(canvasW * INTERNAL_TO_CSS);
    var cssH = Math.ceil(canvasH * INTERNAL_TO_CSS);
    var footCssX = (offsetX + this.CS / 2) * INTERNAL_TO_CSS;
    var contentBottomCss = (offsetY + raw.bottom) * INTERNAL_TO_CSS;
    var actorTop = Math.round(H - BOTTOM_GAP - contentBottomCss);
    var reach = 0;
    this.actions().forEach(function(id){
      var c = self.clip(id);
      if(!c) return;
      for(var i = 0; i < c.frames.length; i += 1){
        var b = self.rawBounds(id, i);
        reach = Math.max(reach, Math.abs(b.left - self.CS / 2) * INTERNAL_TO_CSS, Math.abs(b.right - self.CS / 2) * INTERNAL_TO_CSS);
      }
    });
    reach = Math.ceil(reach);
    var minFoot = Math.ceil(CARD_EDGE_MARGIN + reach);
    var maxFoot = Math.floor(W - CARD_EDGE_MARGIN - reach);
    if(maxFoot < minFoot){
      minFoot = W * .5;
      maxFoot = W * .5;
    }
    return {
      W: W, H: H, raw: raw, safeOffsetX: offsetX, safeOffsetY: offsetY,
      canvasW: canvasW, canvasH: canvasH, cssW: cssW, cssH: cssH,
      footCssX: footCssX, actorTop: actorTop, reach: reach,
      minFoot: minFoot, maxFoot: maxFoot, canvasMargin: SAFE_CANVAS_MARGIN,
      minStageMargin: Math.min(minFoot - reach, W - maxFoot - reach)
    };
  };
  PetRuntime.prototype.applyLayout = function(){
    this.layout = this.computeLayout();
    this.canvas.width = this.layout.canvasW;
    this.canvas.height = this.layout.canvasH;
    this.actor.style.width = this.layout.cssW + "px";
    this.actor.style.height = this.layout.cssH + "px";
    this.actor.style.top = this.layout.actorTop + "px";
    this.actor.style.setProperty("--foot-css-x", this.layout.footCssX + "px");
    this.minFoot = this.layout.minFoot;
    this.maxFoot = this.layout.maxFoot;
    this.footX = Math.max(this.minFoot, Math.min(this.maxFoot, this.footX));
    this.stage.dataset.petCanvasMargin = Math.round(this.layout.canvasMargin * INTERNAL_TO_CSS);
    this.stage.dataset.petStageMargin = Math.round(this.layout.minStageMargin);
    this.stage.dataset.petActor = this.layout.cssW + "x" + this.layout.cssH;
    this.setPos();
  };
  PetRuntime.prototype.setPos = function(){
    if(!this.layout) return;
    this.footX = Math.max(this.minFoot, Math.min(this.maxFoot, this.footX));
    this.actor.style.left = Math.floor(this.footX - this.layout.footCssX) + "px";
    this.actor.style.setProperty("--face", this.faceDir);
    this.stage.dataset.petAction = this.cur;
    this.stage.dataset.petMode = this.mode;
    this.stage.dataset.petFoot = Math.round(this.footX);
    this.stage.dataset.petVx = Math.round(this.vx);
    this.stage.dataset.petFace = this.faceDir;
    this.stage.dataset.petQueue = this.queue.length;
    this.stage.dataset.petReason = this.soul.reason;
    this.stage.dataset.petScale = this.ratioFor(this.cur).toFixed(3);
    window.__fridayPetStageDebug = window.__fridayPetStageDebug || {};
    window.__fridayPetStageDebug[this.surface] = this.metrics();
  };
  PetRuntime.prototype.draw = function(){
    if(!this.layout) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    var c = this.clip(this.cur), im = this.img(this.cur);
    if(!c || !im) return;
    if(this.frame >= c.frames.length) this.frame = 0;
    var m = this.anchorFor(this.cur, this.frame);
    var f = m.frame, r = m.rect, ratio = this.ratioFor(this.cur);
    var dx = Math.floor(this.layout.safeOffsetX + this.CS / 2 - m.anchorX * ratio);
    var dy = Math.floor(this.layout.safeOffsetY + this.CS * FOOTLINE - m.anchorY * ratio);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "high";
    this.ctx.drawImage(im, f[0] + r[0], f[1] + r[1], r[2], r[3], dx, dy, r[2] * ratio, r[3] * ratio);
    var fallback = this.stage.querySelector(".friday-pet-fallback");
    if(fallback) fallback.remove();
  };
  PetRuntime.prototype.frameMs = function(id){
    var n = splitId(id).name;
    if(id === coreId("walk")) return 175;
    if(id === coreId("run")) return 145;
    if(id === coreId("dance")) return 165;
    if(this.isCore(id) && (n === "idle" || n === "sit")) return 230;
    if(this.isEco(id)) return this.clip(id).fps || 320;
    return Math.max(210, this.clip(id).fps || 230);
  };
  PetRuntime.prototype.actionLoops = function(id, opts){
    if(opts && opts.loops) return opts.loops;
    if(this.isEco(id)) return this.clip(id).loops || 1;
    var rules = {
      "core:happy": [3,4], "core:beg": [3,3], "core:play": [3,4],
      "core:dance": [3,3], "core:back": [3,3], "core:sleep": [3,3]
    };
    var span = rules[id];
    if(span) return span[0] + Math.floor(Math.random() * (span[1] - span[0] + 1));
    return 1;
  };
  PetRuntime.prototype.nf = function(id){ return (this.clip(id) || { frames: [] }).frames.length || 1; };
  PetRuntime.prototype.actionsForRole = function(role){
    var self = this;
    var g = this.pack.taxonomy.groups && this.pack.taxonomy.groups[role];
    if(!g) return [];
    return g.actions.filter(function(n){
      return n !== "wake-up-stretch" && self.isEcoAllowed(n);
    }).map(ecoId);
  };
  PetRuntime.prototype.pickEco = function(role){
    var arr = this.actionsForRole(role);
    return arr[Math.floor(Math.random() * arr.length)] || coreId("sit");
  };
  PetRuntime.prototype.pickSleepLoop = function(){
    var loops = [];
    if(this.isEcoAllowed("sleep-curl-zzz")) loops.push(ecoId("sleep-curl-zzz"));
    if(this.isEcoAllowed("sleep-side-breathe")) loops.push(ecoId("sleep-side-breathe"));
    return loops[Math.floor(Math.random() * loops.length)] || coreId("sleep");
  };
  PetRuntime.prototype.sleepSequence = function(){
    if(this.hasAllowedEcoSleep()) return [coreId("sit"), ecoId("rest-stretch-down"), this.pickSleepLoop()];
    return [coreId("sit"), coreId("sleep")];
  };
  PetRuntime.prototype.chooseWeighted = function(candidates){
    var total = 0, i;
    candidates.forEach(function(c){ total += Math.max(.01, c.weight); });
    var r = Math.random() * total;
    for(i = 0; i < candidates.length; i += 1){
      r -= Math.max(.01, candidates[i].weight);
      if(r <= 0) return candidates[i];
    }
    return candidates[candidates.length - 1];
  };
  PetRuntime.prototype.recently = function(id){ return this.soul.history.indexOf(id) >= 0; };
  PetRuntime.prototype.cooldownWeight = function(id, fallback){
    var last = this.lastActionAt[id], cd = fallback || 5200;
    if(last == null) return 1;
    return Math.min(1, Math.max(.08, (this.lifeT - last) / cd));
  };
  PetRuntime.prototype.remember = function(id){
    this.lastActionAt[id] = this.lifeT;
    this.soul.history.push(id);
    if(this.soul.history.length > 8) this.soul.history.shift();
    var effects = {
      self_play: { energy: -.06, curiosity: -.04, sleepiness: .04, affection: .01 },
      attention: { energy: -.03, affection: .08, sleepiness: .02 },
      rest: { energy: .18, sleepiness: -.22, curiosity: -.04 },
      curious: { energy: -.02, curiosity: -.07, sleepiness: .01 },
      food: { energy: .02, curiosity: -.05, affection: .01 },
      turn: { energy: -.02, curiosity: -.07 },
      sit: { energy: .01, sleepiness: .02 },
      mood: { affection: .04, sleepiness: -.02 },
      roam: { energy: -.05, curiosity: -.06, sleepiness: .03 },
      move: { energy: -.05, curiosity: -.10, sleepiness: .02 },
      core: {}
    };
    var b = effects[this.roleOf(id)] || {};
    if(id === coreId("run")) b = { energy: -.18, curiosity: -.09, sleepiness: .08 };
    if(id === coreId("play") || id === coreId("dance")) b = { energy: -.10, affection: .04, sleepiness: .05 };
    if(id === coreId("happy")) b = { energy: -.02, affection: .08, sleepiness: -.03 };
    if(id === coreId("beg")) b = { energy: -.03, affection: .05 };
    if(id === coreId("back")) b = { energy: -.02, curiosity: -.08 };
    this.soul.energy = clamp(this.soul.energy + (b.energy || 0));
    this.soul.curiosity = clamp(this.soul.curiosity + (b.curiosity || 0));
    this.soul.affection = clamp(this.soul.affection + (b.affection || 0));
    this.soul.sleepiness = clamp(this.soul.sleepiness + (b.sleepiness || 0));
  };
  PetRuntime.prototype.driftSoul = function(dt){
    this.soul.energy = clamp(this.soul.energy + dt * .004);
    this.soul.curiosity = clamp(this.soul.curiosity + dt * .010);
    this.soul.sleepiness = clamp(this.soul.sleepiness + dt * .0045);
    this.soul.affection = clamp(this.soul.affection - dt * .0012);
  };
  PetRuntime.prototype.bridge = function(from, to){
    if(!from || from === to) return [];
    if(this.isSleepLoop(to) && from !== coreId("sit") && from !== ecoId("rest-stretch-down")) return [coreId("sit")];
    if(this.isDirectional(from) && !this.isCoreBase(to)) return [Math.random() < .55 ? coreId("sit") : coreId("idle")];
    if((from === coreId("play") || from === coreId("dance") || this.roleOf(from) === "self_play") && this.isDirectional(to)) return [coreId("idle")];
    if(this.isSleepLoop(from) && to !== ecoId("wake-up-stretch")) return [ecoId("wake-up-stretch")];
    return [];
  };
  PetRuntime.prototype.compact = function(seq){
    var self = this, out = [];
    seq.forEach(function(id){
      if(!self.clip(id)) return;
      if(out.length && out[out.length - 1] === id) return;
      out.push(id);
    });
    return out;
  };
  PetRuntime.prototype.makeSequence = function(seq, from){
    var self = this, out = [], prev = from || this.cur;
    this.compact(seq).forEach(function(id){
      self.bridge(prev, id).forEach(function(b){
        if(out[out.length - 1] !== b) out.push(b);
        prev = b;
      });
      if(out[out.length - 1] !== id) out.push(id);
      prev = id;
    });
    return this.compact(out);
  };
  PetRuntime.prototype.pickTarget = function(id){
    if(id === ecoId("roam-step-left")) return Math.max(this.minFoot, Math.round(this.footX - 54));
    if(id === ecoId("roam-step-right")) return Math.min(this.maxFoot, Math.round(this.footX + 54));
    var t = this.minFoot + Math.random() * (this.maxFoot - this.minFoot);
    var minDist = id === coreId("run") ? 88 : 58;
    if(Math.abs(t - this.footX) < minDist) t = this.footX < this.layout.W / 2 ? this.maxFoot : this.minFoot;
    return Math.max(this.minFoot, Math.min(this.maxFoot, Math.round(t)));
  };
  PetRuntime.prototype.sourceFaceForDirection = function(dir){ return dir >= 0 ? -1 : 1; };
  PetRuntime.prototype.start = function(id, opts){
    opts = opts || {};
    clearTimeout(this.beatT);
    if(this.isEco(id) && !this.isEcoAllowed(splitId(id).name)){
      this.stage.dataset.petBlockedAction = id;
      id = coreId("sit");
    }
    if(id === coreId("sleep") && this.hasAllowedEcoSleep()){
      this.startSequence(this.sleepSequence(), opts.reason || "sleepy");
      return;
    }
    this.cur = id;
    this.frame = 0;
    this.frameAcc = 0;
    this.restTimer = 0;
    this.sleepHold = false;
    if(!opts.keepReason) this.soul.reason = opts.reason || "direct";
    this.remember(id);
    if(this.isDirectional(id)){
      this.mode = "loco";
      this.targetX = opts.targetX == null ? this.pickTarget(id) : opts.targetX;
      this.faceDir = this.isEcoLoco(id) ? 1 : this.sourceFaceForDirection(this.targetX - this.footX);
      this.vx = 0;
    } else if(this.isCoreBase(id)){
      this.mode = "base";
      this.vx = 0;
      this.faceDir = 1;
    } else {
      this.mode = this.isSleepLoop(id) ? "rest" : "action";
      this.loops = this.actionLoops(id, opts);
      this.vx = 0;
      this.faceDir = 1;
    }
    this.setPos();
    this.draw();
    if(this.isCoreBase(id)){
      if(this.queue.length) this.start(this.queue.shift(), { keepReason: true });
      else if(this.autoSchedule) this.schedule();
    }
  };
  PetRuntime.prototype.startSequence = function(seq, reason){
    this.soul.reason = reason || "direct";
    var planned = this.makeSequence(seq, this.cur);
    this.queue = planned.slice(1);
    if(planned.length) this.start(planned[0], { keepReason: true });
  };
  PetRuntime.prototype.toBase = function(landing){
    clearTimeout(this.beatT);
    this.mode = "base";
    this.sleepHold = false;
    this.cur = landing || (Math.random() < .58 ? coreId("idle") : coreId("sit"));
    this.frame = 0;
    this.frameAcc = 0;
    this.vx = 0;
    this.faceDir = 1;
    this.restTimer = 0;
    this.setPos();
    this.draw();
    if(this.queue.length) this.start(this.queue.shift(), { keepReason: true });
    else if(this.autoSchedule) this.schedule();
  };
  PetRuntime.prototype.enterSleepHold = function(){
    this.mode = "sleep";
    this.sleepHold = true;
    this.vx = 0;
    this.faceDir = 1;
    this.soul.sleepiness = .96;
    this.setPos();
    this.draw();
  };
  PetRuntime.prototype.chooseIntent = function(){
    var tired = this.soul.sleepiness, energy = this.soul.energy, curious = this.soul.curiosity, affection = this.soul.affection;
    var ignored = this.lifeT - this.lastTouchT;
    var candidates = this.hasAllowedEco() ? [
      { seq: [this.pickEco("sit")], reason: "short_idle", weight: 1.05 + tired * .25 },
      { seq: [this.pickEco("mood"), coreId("sit")], reason: "short_idle", weight: .85 + affection * .45 },
      { seq: [this.pickEco("curious"), coreId("sit")], reason: "eco_explore", weight: .85 + curious * .85 },
      { seq: [this.pickEco("self_play"), coreId("happy"), coreId("sit")], reason: "self_play", weight: .55 + energy * 1.05 - tired * .35 },
      { seq: [this.pickEco("roam"), this.pickEco("curious"), coreId("sit")], reason: "eco_explore", weight: .5 + curious * .9 },
      { seq: [this.pickEco("food"), this.pickEco("mood"), coreId("sit")], reason: "eco_explore", weight: .35 + curious * .65 },
      { seq: [coreId("walk"), this.pickEco("curious"), coreId("sit")], reason: "eco_explore", weight: .42 + curious * .75 + energy * .25 },
      { seq: [this.pickEco("attention"), coreId("happy"), coreId("sit")], reason: "ask_attention", weight: .22 + Math.max(0, ignored - 16000) / 26000 + (1 - affection) * .7 },
      { seq: [coreId("beg"), this.pickEco("attention"), coreId("sit")], reason: "ask_attention", weight: .18 + Math.max(0, ignored - 24000) / 30000 },
      { seq: this.sleepSequence(), reason: "sleepy", weight: .06 + tired * 1.25 - energy * .25 }
    ] : [
      { seq: [coreId("sit")], reason: "short_idle", weight: 1.20 + tired * .25 },
      { seq: [coreId("idle")], reason: "short_idle", weight: 1.05 },
      { seq: [coreId("happy"), coreId("sit")], reason: "ask_attention", weight: .45 + affection * .55 + Math.max(0, ignored - 16000) / 34000 },
      { seq: [coreId("play"), coreId("sit")], reason: "self_play", weight: .38 + energy * .65 - tired * .25 },
      { seq: [coreId("back"), coreId("sit")], reason: "curious", weight: .34 + curious * .45 },
      { seq: [coreId("walk"), coreId("sit")], reason: "curious", weight: .30 + curious * .50 + energy * .25 },
      { seq: this.sleepSequence(), reason: "sleepy", weight: .04 + tired * .90 - energy * .20 }
    ];
    if(energy > .68 && curious > .38 && !this.recently(coreId("run"))){
      candidates.push({ seq: [coreId("run"), coreId("happy"), this.pickEco("mood"), coreId("sit")], reason: "eco_explore", weight: .20 + energy * .45 });
    }
    var self = this;
    candidates.forEach(function(c){
      c.seq = self.makeSequence(c.seq, self.cur);
      var main = c.seq.find(function(id){ return !self.isCoreBase(id); }) || c.seq[0];
      c.weight *= self.cooldownWeight(main, self.isEco(main) ? 6200 : 5200);
      if(self.recently(main)) c.weight *= .5;
      if(ignored < 9000 && self.roleOf(main) === "attention") c.weight *= .25;
      if(ignored > 28000 && self.roleOf(main) === "attention") c.weight *= 1.8;
      if(tired > .78 && c.seq.some(function(id){ return self.isSleepLoop(id); })) c.weight *= 2.2;
      if(tired > .86 && !self.isSleepLoop(main) && !self.isCoreBase(main)) c.weight *= .45;
    });
    return this.chooseWeighted(candidates);
  };
  PetRuntime.prototype.schedule = function(){
    if(!this.autoSchedule) return;
    var self = this;
    clearTimeout(this.beatT);
    this.beatT = setTimeout(function(){
      if(self.dead || self.mode !== "base" || self.queue.length){ self.schedule(); return; }
      var intent = self.chooseIntent();
      self.startSequence(intent.seq, intent.reason);
    }, 5200 + Math.random() * 7600 + this.soul.sleepiness * 2200);
  };
  PetRuntime.prototype.popHearts = function(){
    this.fx.innerHTML = [
      '<span style="--dx:-30px;--dy:-48px;--s:1.15">&hearts;</span>',
      '<span style="--dx:-12px;--dy:-62px;--s:.95">&hearts;</span>',
      '<span style="--dx:8px;--dy:-55px;--s:1.25">&hearts;</span>',
      '<span style="--dx:26px;--dy:-46px;--s:.9">&hearts;</span>',
      '<span style="--dx:0px;--dy:-72px;--s:.78">&hearts;</span>'
    ].join("");
    this.fx.classList.remove("go");
    void this.fx.offsetWidth;
    this.fx.classList.add("go");
  };
  PetRuntime.prototype.boing = function(){
    this.actor.classList.remove("boing");
    void this.actor.offsetWidth;
    this.actor.classList.add("boing");
  };
  PetRuntime.prototype.request = function(id){
    this.lastTouchT = this.lifeT;
    this.soul.affection = clamp(this.soul.affection + .18);
    this.soul.energy = clamp(this.soul.energy + .10);
    this.soul.sleepiness = clamp(this.soul.sleepiness - .18);
    if(this.mode === "sleep"){
      this.startSequence([this.isEcoAllowed("wake-up-stretch") ? ecoId("wake-up-stretch") : coreId("idle"), coreId("happy"), coreId("idle")], "wake");
      return;
    }
    if(id === coreId("sleep")) this.startSequence(this.sleepSequence(), "sleepy");
    else {
      this.queue = [];
      this.startSequence([id], "interaction");
    }
  };
  PetRuntime.prototype.playNow = function(id){
    if(id.indexOf(":") < 0) id = this.pack.core.clips[id] ? coreId(id) : ecoId(id);
    if(this.isEco(id) && !this.isEcoAllowed(splitId(id).name)){
      this.stage.dataset.petBlockedAction = id;
      id = coreId("sit");
    }
    this.lastTouchT = this.lifeT;
    this.queue = [];
    if(id === coreId("sleep") && this.hasAllowedEcoSleep()){
      this.startSequence(this.sleepSequence(), "sleepy");
      return;
    }
    if(this.mode === "sleep" && id !== ecoId("wake-up-stretch")){
      this.startSequence([this.isEcoAllowed("wake-up-stretch") ? ecoId("wake-up-stretch") : coreId("idle"), id], "wake");
      return;
    }
    this.start(id, { reason: "direct" });
  };
  PetRuntime.prototype.advanceFrame = function(){
    this.frame = (this.frame + 1) % this.nf(this.cur);
    this.draw();
    if(this.frame === 0 && (this.mode === "action" || this.mode === "rest")){
      this.loops -= 1;
      if(this.loops <= 0){
        if(this.queue.length){
          this.start(this.queue.shift(), { keepReason: true });
        } else if(this.isSleepLoop(this.cur)){
          this.enterSleepHold();
        } else {
          this.toBase();
        }
      }
    }
  };
  PetRuntime.prototype.updatePhysics = function(dt){
    if(this.mode !== "loco") return;
    if(this.restTimer > 0){
      this.restTimer -= dt * 1000;
      this.vx *= Math.pow(.001, dt);
      if(this.restTimer <= 0) this.toBase();
      this.setPos();
      return;
    }
    var name = splitId(this.cur).name;
    var cl = this.clip(this.cur);
    var dir = this.targetX >= this.footX ? 1 : -1;
    var cycleMs = this.frameMs(this.cur) * this.nf(this.cur);
    var speed = this.isEcoLoco(this.cur) ? 22 : ((cl.stridePx || 28) * this.coreActionScale(name)) / (cycleMs / 1000);
    var desired = dir * speed;
    this.vx += (desired - this.vx) * Math.min(1, dt * 4.5);
    this.footX += this.vx * dt;
    this.faceDir = this.isEcoLoco(this.cur) ? 1 : this.sourceFaceForDirection(this.vx);
    if((dir > 0 && this.footX >= this.targetX) || (dir < 0 && this.footX <= this.targetX) || Math.abs(this.targetX - this.footX) < 2){
      this.footX = this.targetX;
      this.vx = 0;
      this.cur = Math.random() < .45 ? coreId("idle") : coreId("sit");
      this.frame = 0;
      this.frameAcc = 0;
      this.faceDir = 1;
      this.soul.reason = "moved";
      this.draw();
      this.restTimer = 2600 + Math.random() * 2200;
    }
    this.setPos();
  };
  PetRuntime.prototype.tick = function(ts){
    if(this.dead) return;
    if(!this.lastTs) this.lastTs = ts;
    var dt = Math.min(.05, (ts - this.lastTs) / 1000);
    this.lastTs = ts;
    this.lifeT += dt * 1000;
    this.driftSoul(dt);
    this.updatePhysics(dt);
    this.frameAcc += dt * 1000;
    var ms = this.mode === "sleep" ? Math.max(this.frameMs(this.cur), 360) : this.frameMs(this.cur);
    while(this.frameAcc >= ms){
      this.frameAcc -= ms;
      this.advanceFrame();
    }
    this.setPos();
    requestAnimationFrame(this.tick.bind(this));
  };
  PetRuntime.prototype.attach = function(){
    var self = this;
    if(this.interactive){
      this.stage.addEventListener("pointerenter", function(){ if(self.mode === "base") self.request(coreId("happy")); });
      this.stage.addEventListener("pointerdown", function(){
        if(self.mode === "sleep") self.playNow(coreId("happy"));
        else self.playNow(coreId("happy"));
        self.popHearts();
        self.boing();
      });
    }
    this.actor.addEventListener("animationend", function(e){
      if(e.animationName === "fridayPetBoing") self.actor.classList.remove("boing");
    });
    window.addEventListener("resize", function(){
      if(self.dead) return;
      self.applyLayout();
      self.draw();
    });
  };
  PetRuntime.prototype.metrics = function(){
    return {
      version: this.options.ecoVersion || "mobile-desktop-eco-v4-20260606-1",
      surface: this.surface,
      ecoAllowlist: this.allowedEcoNames(),
      action: this.cur,
      frame: this.frame,
      mode: this.mode,
      foot: Math.round(this.footX),
      vx: Math.round(this.vx),
      minFoot: Math.round(this.minFoot),
      maxFoot: Math.round(this.maxFoot),
      scale: this.ratioFor(this.cur),
      ecoScale: this.ecoScale,
      soul: JSON.parse(JSON.stringify(this.soul)),
      layout: this.layout
    };
  };
  PetRuntime.prototype.destroy = function(){
    this.dead = true;
    clearTimeout(this.beatT);
    if(this.actor && this.actor.parentNode) this.actor.parentNode.removeChild(this.actor);
  };

  window.FridayPetStage = { createStage: createStage, loadPack: loadPack, coreId: coreId, ecoId: ecoId };
})();
