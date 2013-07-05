/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/
var Template = require("./Template");
var BasicEvaluatedExpression = require("./BasicEvaluatedExpression");
var ModuleHotAcceptDependency = require("./dependencies/ModuleHotAcceptDependency");
var ModuleHotDeclineDependency = require("./dependencies/ModuleHotDeclineDependency");
var RawSource = require("webpack-core/lib/RawSource");

function HotModuleReplacementPlugin(outputOptions) {
	this.outputOptions = outputOptions;
}
module.exports = HotModuleReplacementPlugin;

HotModuleReplacementPlugin.prototype.apply = function(compiler) {
	var hotUpdateChunkFilename = this.outputOptions.hotUpdateChunkFilename || "[id].[hash].hot-update.js";
	var hotUpdateMainFilename = this.outputOptions.hotUpdateMainFilename || "[hash].hot-update.json";
	var hotUpdateFunction = this.outputOptions.hotUpdateFunction || ("webpackHotUpdate" + (this.outputOptions.library || ""));
	compiler.plugin("compilation", function(compilation, params) {
		var hotUpdateChunkTemplate = compilation.compiler.hotUpdateChunkTemplate;
		if(!hotUpdateChunkTemplate) return;

		var normalModuleFactory = params.normalModuleFactory;
		var contextModuleFactory = params.contextModuleFactory;

		compilation.dependencyFactories.set(ModuleHotAcceptDependency, normalModuleFactory);
		compilation.dependencyTemplates.set(ModuleHotAcceptDependency, new ModuleHotAcceptDependency.Template());

		compilation.dependencyFactories.set(ModuleHotDeclineDependency, normalModuleFactory);
		compilation.dependencyTemplates.set(ModuleHotDeclineDependency, new ModuleHotDeclineDependency.Template());

		compilation.plugin("record", function(compilation, records) {
			if(records.hash === this.hash) return;
			records.hash = compilation.hash;
			records.moduleHashs = {};
			this.modules.forEach(function(module) {
				var identifier = module.identifier();
				var hash = new (require("crypto")).Hash("md5");
				module.updateHash(hash);
				records.moduleHashs[identifier] = hash.digest("hex");
			});
			records.chunkHashs = {};
			this.chunks.forEach(function(chunk) {
				records.chunkHashs[chunk.id] = chunk.hash;
			});
			records.chunkModuleIds = {};
			this.chunks.forEach(function(chunk) {
				records.chunkModuleIds[chunk.id] = chunk.modules.map(function(m) { return m.id; });
			});
		});
		compilation.plugin("after-hash", function() {
			var records = this.records;
			if(!records) return;
			if(!records.hash) return;
			if(!records.preHash) {
				records.preHash = this.hash;
				return;
			}
			if(records.preHash === this.hash) {
				if(records.prepreHash)
					this.modifyHash(records.prepreHash);
				return;
			}
			records.preHash = this.hash;
			records.prepreHash = records.preHash;
			this.modifyHash(records.preHash);
		});
		compilation.plugin("additional-chunk-assets", function() {
			var records = this.records;
			if(records.hash === this.hash) return;
			if(!records.moduleHashs || !records.chunkHashs || !records.chunkModuleIds) return;
			var moduleHashs = {};
			this.modules.forEach(function(module) {
				var identifier = module.identifier();
				var hash = new (require("crypto")).Hash("md5");
				module.updateHash(hash);
				hash = hash.digest("hex");
				module.hotUpdate = records.moduleHashs[identifier] !== hash;
			});
			var hotUpdateMainContent = {
				h: this.hash,
				c: []
			};
			Object.keys(records.chunkHashs).forEach(function(chunkId) {
				chunkId = +chunkId;
				var newModules = [];
				var removedModules = records.chunkModuleIds[chunkId].slice();
				var currentChunk = this.chunks.filter(function(chunk) {
					return chunk.id === chunkId;
				})[0];
				if(currentChunk) {
					currentChunk.modules.forEach(function(module) {
						var idx = removedModules.indexOf(module.id);
						if(idx >= 0) {
							removedModules.splice(idx, 1);
							if(!module.hotUpdate) return;
						}
						newModules.push(module);
					});
				}
				newModules = removedModules.concat(newModules);
				if(newModules.length > 0) {
					var source = hotUpdateChunkTemplate.render(chunkId, newModules, this.hash, this.moduleTemplate, this.dependencyTemplates);
					var filename = hotUpdateChunkFilename
						.replace(Template.REGEXP_HASH, records.hash)
						.replace(Template.REGEXP_ID, chunkId);
					this.assets[filename] = source;
					hotUpdateMainContent.c.push(chunkId);
					if(currentChunk) {
						currentChunk.files.push(filename);
						this.applyPlugins("chunk-asset", currentChunk, filename);
					} else {
						this.additionalChunkAssets.push(filename);
						this.applyPlugins("chunk-asset", null, filename);
					}
				}
			}, this);
			var source = new RawSource(JSON.stringify(hotUpdateMainContent));
			var filename = hotUpdateMainFilename.replace(Template.REGEXP_HASH, records.hash);
			this.assets[filename] = source;
		});

		var mainTemplate = compilation.mainTemplate;
		compilation.mainTemplate = Object.create(mainTemplate);

		compilation.mainTemplate.updateHash = function(hash) {
			hash.update("HotMainTemplateDecorator");
			mainTemplate.updateHash(hash);
		};

		compilation.mainTemplate.renderRequireFunctionForModule = function(hash, chunk, varModuleId) {
			return "hotCreateRequire(" + varModuleId + ")";
		};

		compilation.mainTemplate.renderInit = function(hash, chunk) {
			var buf = mainTemplate.renderInit(hash, chunk);
			var currentHotUpdateChunkFilename = JSON.stringify(hotUpdateChunkFilename)
				.replace(Template.REGEXP_HASH, "\" + " + this.renderCurrentHashCode(hash) + " + \"")
				.replace(Template.REGEXP_ID, "\" + chunkId + \"");
			var currentHotUpdateMainFilename = JSON.stringify(hotUpdateMainFilename)
				.replace(Template.REGEXP_HASH, "\" + " + this.renderCurrentHashCode(hash) + " + \"");
			buf.push("this[" + JSON.stringify(hotUpdateFunction) + "] = " +
				(hotInitCode
					.replace(/\$require\$/g, this.requireFn)
					.replace(/\$hotMainFilename\$/g, currentHotUpdateMainFilename)
					.replace(/\$hotChunkFilename\$/g, currentHotUpdateChunkFilename)
					.replace(/\$hash\$/g, JSON.stringify(hash))
					.replace(/\/\*foreachInstalledChunks\*\//g, chunk.chunks.length > 0 ? "for(var chunkId in installedChunks)" : "var chunkId = 0;")));
			return buf;
		};

		compilation.mainTemplate.renderCurrentHashCode = function(hash) {
			return "hotCurrentHash";
		};

		compilation.mainTemplate.renderModule = function(hash, chunk, varModuleId) {
			var buf = mainTemplate.renderModule(hash, chunk, varModuleId);
			buf.push(buf.pop() + ",");
			buf.push("hot: hotCreateModule(" + varModuleId + "),");
			buf.push("parents: [hotCurrentParent],");
			buf.push("data: hotCurrentModuleData[" + varModuleId + "],");
			buf.push("children: []");
			return buf;
		};

	});
	compiler.parser.plugin("evaluate Identifier module.hot", function(expr) {
		return new BasicEvaluatedExpression()
			.setBoolean(!!this.state.compilation.compiler.hotUpdateChunkTemplate)
			.setRange(expr.range);
	});
	compiler.parser.plugin("call module.hot.accept", function(expr) {
		if(!this.state.compilation.compiler.hotUpdateChunkTemplate) return false;
		if(expr.arguments.length > 1) {
			var param = this.evaluateExpression(expr.arguments[0]);
			if(param.isString()) {
				var dep = new ModuleHotAcceptDependency(param.string, param.range);
				dep.optional = true;
				this.state.module.addDependency(dep);
			}
		}
	});
	compiler.parser.plugin("call module.hot.decline", function(expr) {
		if(!this.state.compilation.compiler.hotUpdateChunkTemplate) return false;
		if(expr.arguments.length > 1) {
			var param = this.evaluateExpression(expr.arguments[0]);
			if(param.isString()) {
				var dep = new ModuleHotDeclineDependency(param.string, param.range);
				dep.optional = true;
				this.state.module.addDependency(dep);
			}
		}
	});
	compiler.parser.plugin("expression module.hot", function() {
		return true;
	});
};

var hotInitCode = function() {
	function webpackHotUpdateCallback(chunkId, moreModules) {
		for(var moduleId in moreModules) {
			if(moreModules[moduleId])
				hotUpdate[moduleId] = moreModules[moduleId];
			else if(!hotUpdate[moduleId])
				hotUpdate[moduleId] = false;
		}
		if(--hotWaitingFiles === 0 && hotChunksLoading === 0) {
			hotUpdateDownloaded();
		}
	}

	var hotApplyOnUpdate = true;
	var hotCurrentHash = $hash$;
	var hotCurrentModuleData = {};
	var hotCurrentParent = 0;

	function hotCreateRequire(moduleId) {
		var me = installedModules[moduleId];
		var fn = function(request) {
			if(installedModules[request] && installedModules[request].parents.indexOf(moduleId) < 0)
				installedModules[request].parents.push(moduleId);
			if(me && me.children.indexOf(request) < 0)
				me.children.push(request);
			hotCurrentParent = moduleId;
			return $require$(request);
		};
		fn.e = function(chunkId, callback) {
			if(hotStatus === "ready")
				hotSetStatus("prepare");
			hotChunksLoading++;
			$require$.e(chunkId, function() {
				try {
					callback.call(null, fn);
				} catch(e) {
					finishChunkLoading();
					throw e;
				}
				finishChunkLoading();
				function finishChunkLoading() {
					hotChunksLoading--;
					if(hotStatus === "prepare") {
						if(!hotWaitingFilesMap[chunkId]) {
							hotDownloadUpdateChunk(chunkId);
						}
						if(hotChunksLoading === 0 && hotWaitingFiles === 0) {
							hotUpdateDownloaded();
						}
					}
				}
			});
		}
		fn.cache = $require$.cache;
		fn.modules = $require$.modules;
		return fn;
	}

	function hotCreateModule(moduleId) {
		var hot = {
			// private stuff
			_acceptedDependencies: {},
			_declinedDependencies: {},
			_selfAccepted: false,
			_selfDeclined: false,
			_disposeHandlers: [],

			// Module API
			accept: function(dep, callback) {
				if(typeof dep === "undefined")
					hot._selfAccepted = true;
				else if(typeof dep === "number")
					hot._acceptedDependencies[dep] = callback;
				else for(var i = 0; i < dep.length; i++)
					hot._acceptedDependencies[dep[i]] = callback;
			},
			decline: function(dep) {
				if(typeof dep === "undefined")
					hot._selfDeclined = true;
				else if(typeof dep === "number")
					hot._declinedDependencies[dep] = true;
				else for(var i = 0; i < dep.length; i++)
					hot._declinedDependencies[dep[i]] = true;
			},
			dispose: function(callback) {
				hot._disposeHandlers.push(callback);
			},
			addDisposeHandler: function(callback) {
				hot._disposeHandlers.push(callback);
			},
			removeDisposeHandler: function(callback) {
				var idx = hot._disposeHandlers.indexOf(callback);
				if(idx >= 0) hot._disposeHandlers.splice(idx, 1);
			},

			// Management API
			check: hotCheck,
			apply: hotApply,
			setApplyOnUpdate: function(applyOnUpdate) {
				hotApplyOnUpdate = applyOnUpdate;
			},
			status: function(l) {
				if(!l) return hotStatus;
				hotStatusHandlers.push(l);
			},
			addStatusHandler: function(l) {
				hotStatusHandlers.push(l);
			},
			removeStatusHandler: function(l) {
				var idx = hotStatusHandlers.indexOf(l);
				if(idx >= 0) hotStatusHandlers.splice(idx, 1);
			}
		};
		return hot;
	}

	var hotStatusHandlers = [];
	var hotStatus = "idle";

	function hotSetStatus(newStatus) {
		var oldStatus = hotStatus;
		hotStatus = newStatus;
		for(var i = 0; i < hotStatusHandlers.length; i++)
			hotStatusHandlers[i].call(null, newStatus);
	}

	// while downloading
	var hotWaitingFiles = 0;
	var hotChunksLoading = 0;
	var hotWaitingFilesMap = {};
	var hotAvailibleFilesMap = {};
	var hotCallback;

	// The update info
	var hotUpdate, hotUpdateNewHash;

	function hotCheck(callback) {
		callback = callback || function(err) { if(err) throw err };
		if(hotStatus !== "idle") throw new Error("check() is only allowed in idle status");
		if(typeof XMLHttpRequest === "undefined")
			return callback(new Error("No browser support"));
		hotSetStatus("check");

		try {
			var request = new XMLHttpRequest();
			request.open("GET", modules.c + $hotMainFilename$, true);
			request.send(null);
		} catch(err) {
			return callback(err);
		}
		request.onreadystatechange = function() {
			if(request.readyState !== 4) return;
			if(request.status !== 200 && request.status !== 304) {

				hotSetStatus("idle");
				callback(null, null);

			} else {

				try {
					var update = JSON.parse(request.responseText);
				} catch(e) {
					hotSetStatus("idle");
					callback(null, null);
					return;
				}

				hotAvailibleFilesMap = {};
				hotWaitingFilesMap = {};
				for(var i = 0; i < update.c.length; i++)
					hotAvailibleFilesMap[update.c[i]] = true;
				hotUpdateNewHash = update.h;

				hotSetStatus("prepare");
				hotCallback = callback;
				hotUpdate = {};
				/*foreachInstalledChunks*/ {
					hotDownloadUpdateChunk(chunkId);
				}
				if(hotChunksLoading === 0 && hotWaitingFiles === 0) {
					hotUpdateDownloaded();
				}
			}
		};
	}

	function hotDownloadUpdateChunk(chunkId) {
		if(hotAvailibleFilesMap[chunkId]) {
			hotWaitingFiles++;
			var head = document.getElementsByTagName('head')[0];
			var script = document.createElement('script');
			script.type = 'text/javascript';
			script.charset = 'utf-8';
			script.src = modules.c + $hotChunkFilename$;
			head.appendChild(script);
		}
		hotWaitingFilesMap[chunkId] = true;
	}

	function hotUpdateDownloaded() {
		hotSetStatus("ready");
		var callback = hotCallback;
		hotCallback = null;
		if(!callback) return;
		if(hotApplyOnUpdate) {
			hotApply(callback);
		} else {
			var outdatedModules = [];
			for(var id in hotUpdate) {
				outdatedModules.push(+id);
			}
			callback(null, outdatedModules);
		}
	}

	function hotApply(callback) {
		callback = callback || function(err) { if(err) throw err };
		if(hotStatus !== "ready") throw new Error("apply() is only allowed in ready status");
		var outdatedDependencies = {};
		var outdatedModules = [];
		for(var id in hotUpdate) {
			outdatedModules.push(+id);
		}
		var queue = outdatedModules.slice();
		while(queue.length > 0) {
			var moduleId = queue.pop();
			var module = installedModules[moduleId];
			if(!module || module.hot._selfAccepted)
				continue;
			if(module.hot._selfDeclined) {
				hotSetStatus("abort");
				return callback(new Error("Aborted because of self decline: " + moduleId));
			}
			if(moduleId === 0) {
				hotSetStatus("abort");
				return callback(new Error("Aborted because of bubbling"));
			}
			for(var i = 0; i < module.parents.length; i++) {
				var parentId = module.parents[i];
				var parent = installedModules[parentId];
				if(parent.hot._declinedDependencies[moduleId]) {
					hotSetStatus("abort");
					return callback(new Error("Aborted because of declined dependency: " + moduleId + " in " + parentId));
				}
				if(outdatedModules.indexOf(parentId) >= 0) continue;
				if(parent.hot._acceptedDependencies[moduleId]) {
					if(!outdatedDependencies[parentId]) outdatedDependencies[parentId] = [];
					if(outdatedDependencies[parentId].indexOf(moduleId) >= 0) continue;
					outdatedDependencies[parentId].push(moduleId);
					continue;
				}
				delete outdatedDependencies[parentId];
				outdatedModules.push(parentId);
				queue.push(parentId);
			}
		}

		var outdatedSelfAcceptedModules = [];
		for(var i = 0; i < outdatedModules.length; i++) {
			var moduleId = outdatedModules[i];
			if(installedModules[moduleId] && installedModules[moduleId].hot._selfAccepted)
				outdatedSelfAcceptedModules.push(moduleId);
		}

		hotSetStatus("dispose");
		hotCurrentModuleData = {};
		for(var i = 0; i < outdatedModules.length; i++) {
			var moduleId = outdatedModules[i];
			var data = {};
			var module = installedModules[moduleId];
			if(!module) continue;
			var disposeHandlers = module.hot._disposeHandlers;
			for(var j = 0; j < disposeHandlers.length; j++) {
				var cb = disposeHandlers[j]
				cb(data);
			}
			hotCurrentModuleData[moduleId] = data;
		}
		for(var i = 0; i < outdatedModules.length; i++) {
			var moduleId = outdatedModules[i];
			var module = installedModules[moduleId];
			if(!module) continue;
			delete installedModules[moduleId];
			for(var j = 0; j < module.children.length; j++) {
				var child = installedModules[module.children[j]];
				if(!child) continue;
				var idx = child.parents.indexOf(moduleId);
				if(idx >= 0) child.parents.splice(idx, 1);
			}
		}
		for(var moduleId in outdatedDependencies) {
			var module = installedModules[moduleId];
			var moduleOutdatedDependencies = outdatedDependencies[moduleId];
			for(var j = 0; j < moduleOutdatedDependencies.length; j++) {
				var dependency = moduleOutdatedDependencies[j];
				var idx = module.children.indexOf(dependency);
				if(idx >= 0) module.children.splice(idx, 1);
			}
		}

		hotSetStatus("apply");

		hotCurrentHash = hotUpdateNewHash;

		// insert new code
		for(var moduleId in hotUpdate) {
			var fn = hotUpdate[moduleId];
			if(fn) modules[moduleId] = fn;
			else delete modules[moduleId];
		}

		// call accept handlers
		var error = null;
		for(var moduleId in outdatedDependencies) {
			var module = installedModules[moduleId];
			var moduleOutdatedDependencies = outdatedDependencies[moduleId];
			var callbacks = [];
			for(var i = 0; i < moduleOutdatedDependencies.length; i++) {
				var dependency = moduleOutdatedDependencies[i];
				var cb = module.hot._acceptedDependencies[dependency];
				if(callbacks.indexOf(cb) >= 0) continue;
				callbacks.push(cb);
			}
			for(var i = 0; i < callbacks.length; i++) {
				var cb = callbacks[i];
				try {
					cb(outdatedDependencies);
				} catch(err) {
					if(!error)
						error = err;
				}
			}
		}
		if(error) {
			hotSetStatus("fail");
			return callback(error);
		}

		// Load self accepted
		for(var i = 0; i < outdatedSelfAcceptedModules.length; i++) {
			var moduleId = outdatedSelfAcceptedModules[i];
			hotCurrentParent = moduleId;
			$require$(moduleId);
		}

		hotSetStatus("idle");
		callback(null, outdatedModules);
	}
}.toString().replace(/^function\s?\(\)\s?\{\n?|\n?\}$/g, "").replace(/^\t/mg, "");