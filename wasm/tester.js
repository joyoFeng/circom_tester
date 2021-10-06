const chai = require("chai");
const assert = chai.assert;

const fs = require("fs");
var tmp = require("tmp-promise");
const path = require("path");

const util = require("util");
const exec = util.promisify(require("child_process").exec);

const loadR1cs = require("r1csfile").load;
const ZqField = require("ffjavascript").ZqField;

module.exports = wasm_tester;

async function  wasm_tester(circomInput, _options) {

    assert(await compiler_above_version("2.0.0"),"Wrong compiler version. Must be at least 2.0.0");
    
    tmp.setGracefulCleanup();

    const dir = await tmp.dir({prefix: "circom_", unsafeCleanup: true });

    //console.log(dir.path);

    const baseName = path.basename(circomInput, ".circom");
    const options = Object.assign({}, _options);

    options.wasm = true;

    options.sym = true;
    options.json = options.json || false; // costraints in json format
    options.r1cs = true;
    options.output = dir.path;

    await compile(circomInput, options);

    const utils = require("./utils");
    const WitnessCalculator = require("./witness_calculator");

    const wasm = await fs.promises.readFile(path.join(dir.path, baseName+"_js/"+ baseName + ".wasm"));

    const wc = await WitnessCalculator(wasm);

    return new WasmTester(dir, baseName, wc);
}

async function compile (fileName, options) {    
    var flags = "--wasm ";
    if (options.sym) flags += "--sym ";
    if (options.r1cs) flags += "--r1cs ";
    if (options.json) flags += "--json ";
    if (options.output) flags += "--output " + options.output + " ";
    console.log(circom + flags + fileName);
    
    await exec("circom " + flags + fileName);
}
    
class WasmTester {

    constructor(dir, baseName, witnessCalculator) {
        this.dir=dir;
        this.baseName = baseName;
        this.witnessCalculator = witnessCalculator;
    }

    async release() {
        await this.dir.cleanup();
    }

    async calculateWitness(input, sanityCheck) {
        return await this.witnessCalculator.calculateWitness(input, sanityCheck);
    }

    async loadSymbols() {
        if (this.symbols) return;
        this.symbols = {};
        const symsStr = await fs.promises.readFile(
            path.join(this.dir.path, this.baseName + ".sym"),
            "utf8"
        );
        const lines = symsStr.split("\n");
        for (let i=0; i<lines.length; i++) {
            const arr = lines[i].split(",");
            if (arr.length!=4) continue;
            this.symbols[arr[3]] = {
                labelIdx: Number(arr[0]),
                varIdx: Number(arr[1]),
                componentIdx: Number(arr[2]),
            };
        }
    }

    async loadConstraints() {
        const self = this;
        if (this.constraints) return;
        const r1cs = await loadR1cs(path.join(this.dir.path, this.baseName + ".r1cs"),true, false);
        self.F = new ZqField(r1cs.prime);
        self.nVars = r1cs.nVars;
        self.constraints = r1cs.constraints;
    }

    async assertOut(actualOut, expectedOut) {
        const self = this;
        if (!self.symbols) await self.loadSymbols();

        checkObject("main", expectedOut);

        function checkObject(prefix, eOut) {

            if (Array.isArray(eOut)) {
                for (let i=0; i<eOut.length; i++) {
                    checkObject(prefix + "["+i+"]", eOut[i]);
                }
            } else if ((typeof eOut == "object")&&(eOut.constructor.name == "Object")) {
                for (let k in eOut) {
                    checkObject(prefix + "."+k, eOut[k]);
                }
            } else {
                if (typeof self.symbols[prefix] == "undefined") {
                    assert(false, "Output variable not defined: "+ prefix);
                }
                const ba = actualOut[self.symbols[prefix].varIdx].toString();
                const be = eOut.toString();
                assert.strictEqual(ba, be, prefix);
            }
        }
    }

    async getDecoratedOutput(witness) {
        const self = this;
        const lines = [];
        if (!self.symbols) await self.loadSymbols();
        for (let n in self.symbols) {
            let v;
            if (utils.isDefined(witness[self.symbols[n].varIdx])) {
                v = witness[self.symbols[n].varIdx].toString();
            } else {
                v = "undefined";
            }
            lines.push(`${n} --> ${v}`);
        }
        return lines.join("\n");
    }

    async checkConstraints(witness) {
        const self = this;
        if (!self.constraints) await self.loadConstraints();
        for (let i=0; i<self.constraints.length; i++) {
            checkConstraint(self.constraints[i]);
        }

        function checkConstraint(constraint) {
	    
            const F = self.F;
            const a = evalLC(constraint[0]);
            const b = evalLC(constraint[1]);
            const c = evalLC(constraint[2]);
            assert (F.isZero(F.sub(F.mul(a,b), c)), "Constraint doesn't match");
        }

        function evalLC(lc) {
            const F = self.F;
            let v = F.zero;
            for (let w in lc) {
                v = F.add(
                    v,
                    F.mul( lc[w], witness[w] )
                );
            }
            return v;
        }
    }

}

function version_to_list ( v ) {
    return v.split(".").map(function(x) {
	return parseInt(x, 10);
    });
}

function check_versions ( v1, v2 ) {
    //check if v1 is newer than or equal to v2
    for (let i = 0; i < v2.length; i++) {
	if (v1[i] > v2[i]) return true;
	if (v1[i] < v2[i]) return false;
    }
    return true;
}

async function compiler_above_version(v) {
    let output = await exec('circom --version').toString();
    let compiler_version = version_to_list(output.slice(output.search(/\d/),-1));
    vlist = version_to_list(v);
    return check_versions ( compiler_version, vlist );
}

