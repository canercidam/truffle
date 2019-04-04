import debugModule from "debug";
const debug = debugModule("debugger:session");

import configureStore from "lib/store";

import * as controller from "lib/controller/actions";
import * as actions from "./actions";
import data from "lib/data/selectors";
import solidity from "lib/solidity/selectors";
import controllerSelector from "lib/controller/selectors";

import rootSaga from "./sagas";
import reducer from "./reducers";

import { anyNonSkippedInRange } from "lib/ast/map";

/**
 * Debugger Session
 */
export default class Session {
  /**
   * @param {Array<Contract>} contracts - contract definitions
   * @param {Array<String>} files - array of filenames for sourceMap indexes
   * @param {string} txHash - transaction hash
   * @param {Web3Provider} provider - web3 provider
   * @private
   */
  constructor(contracts, files, txHash, provider) {
    /**
     * @private
     */
    this._store = configureStore(reducer, rootSaga);

    let { contexts, sources } = Session.normalize(contracts, files);

    // record contracts
    this._store.dispatch(actions.recordContracts(contexts, sources));

    this._store.dispatch(actions.start(txHash, provider));
  }

  async ready() {
    return new Promise((accept, reject) => {
      this._store.subscribe(() => {
        if (this.state.session.status == "ACTIVE") {
          accept();
        } else if (typeof this.state.session.status == "object") {
          reject(this.state.session.status.error);
        }
      });
    });
  }

  /**
   * Split up artifacts into "contexts" and "sources", dividing artifact
   * data into appropriate buckets.
   *
   * Multiple contracts can be defined in the same source file, but have
   * different bytecodes.
   *
   * This iterates over the contracts and collects binaries separately
   * from sources, using the optional `files` argument to force
   * source ordering.
   * @private
   */
  static normalize(contracts, files = null) {
    let sourcesByPath = {};
    let contexts = [];
    let sources;

    for (let contract of contracts) {
      let {
        contractName,
        binary,
        sourceMap,
        deployedBinary,
        deployedSourceMap,
        sourcePath,
        source,
        ast,
        compiler
      } = contract;

      debug("sourceMap %o", sourceMap);
      debug("compiler %o", compiler);

      let contractId = ast.nodes.find(
        node =>
          node.nodeType === "ContractDefinition" && node.name === contractName
      ).id; //could also record contractKind, but we don't need to

      debug("contractId %d", contractId);

      sourcesByPath[sourcePath] = { sourcePath, source, ast };

      if (binary && binary != "0x") {
        contexts.push({
          contractName,
          binary,
          sourceMap,
          contractId
        });
      }

      if (deployedBinary && deployedBinary != "0x") {
        contexts.push({
          contractName,
          binary: deployedBinary,
          sourceMap: deployedSourceMap,
          compiler,
          contractId
        });
      }
    }

    if (!files) {
      sources = Object.values(sourcesByPath);
    } else {
      sources = files.map(file => sourcesByPath[file]);
    }

    return { contexts, sources };
  }

  get state() {
    return this._store.getState();
  }

  view(selector) {
    return selector(this.state);
  }

  async dispatch(action) {
    this._store.dispatch(action);

    return true;
  }

  async interrupt() {
    return this.dispatch(controller.interrupt());
  }

  async doneStepping(stepperAction) {
    return new Promise(resolve => {
      let hasStarted = false;
      let hasResolved = false;
      const unsubscribe = this._store.subscribe(() => {
        const isStepping = this.view(controllerSelector.isStepping);

        if (isStepping && !hasStarted) {
          hasStarted = true;
          debug("heard step start");
          return;
        }

        if (!isStepping && hasStarted && !hasResolved) {
          hasResolved = true;
          debug("heard step stop");
          unsubscribe();
          resolve(true);
        }
      });
      this.dispatch(stepperAction);
    });
  }

  //Note: count is an optional argument; default behavior is to advance 1
  async advance(count) {
    return await this.doneStepping(controller.advance(count));
  }

  async stepNext() {
    return await this.doneStepping(controller.stepNext());
  }

  async stepOver() {
    return await this.doneStepping(controller.stepOver());
  }

  async stepInto() {
    return await this.doneStepping(controller.stepInto());
  }

  async stepOut() {
    return await this.doneStepping(controller.stepOut());
  }

  async reset() {
    return await this.doneStepping(controller.reset());
  }

  //NOTE: breakpoints is an OPTIONAL argument for if you want to supply your
  //own list of breakpoints; leave it out to use the internal one (as
  //controlled by the functions below)
  async continueUntilBreakpoint(breakpoints) {
    return await this.doneStepping(
      controller.continueUntilBreakpoint(breakpoints)
    );
  }

  async addBreakpoint(breakpoint) {
    this.dispatch(controller.addBreakpoint(breakpoint));
  }

  //this function adjusts a given line-based breakpoint (on node-based
  //breakpoints it simply returns the input) by repeatedly moving it down a
  //line until it lands on a line where there's actually somewhere to break.
  //if no such line exists beyond that point, it returns null instead.
  adjustBreakpoint(breakpoint) {
    let adjustedBreakpoint;
    if (breakpoint.node === undefined) {
      let line = breakpoint.line;
      let { source, ast } = this.view(solidity.info.sources)[
        breakpoint.sourceId
      ];
      let lineLengths = source.split("\n").map(line => line.length);
      //why does neither JS nor lodash have a scan function like Haskell??
      //guess we'll have to do our scan manually
      let lineStarts = [0];
      for (let length of lineLengths) {
        lineStarts.push(lineStarts[lineStarts.length - 1] + length + 1);
        //+1 for the /n itself
      }
      debug(
        "line: %s",
        source.slice(lineStarts[line], lineStarts[line] + lineLengths[line])
      );
      while (
        line < lineLengths.length &&
        !anyNonSkippedInRange(ast, lineStarts[line], lineLengths[line])
      ) {
        debug("incrementing");
        line++;
      }
      if (line >= lineLengths.length) {
        adjustedBreakpoint = null;
      } else {
        adjustedBreakpoint = { ...breakpoint, line };
      }
    } else {
      debug("node-based breakpoint");
      adjustedBreakpoint = breakpoint;
    }
    return adjustedBreakpoint;
  }

  async removeBreakpoint(breakpoint) {
    return this.dispatch(controller.removeBreakpoint(breakpoint));
  }

  async removeAllBreakpoints() {
    return this.dispatch(controller.removeAllBreakpoints());
  }

  async decodeReady() {
    return new Promise(resolve => {
      let haveResolved = false;
      const unsubscribe = this._store.subscribe(() => {
        const subscriptionDecodingStarted = this.view(data.proc.decodingKeys);

        debug("following decoding started: %d", subscriptionDecodingStarted);

        if (subscriptionDecodingStarted <= 0 && !haveResolved) {
          haveResolved = true;
          unsubscribe();
          resolve();
        }
      });

      const decodingStarted = this.view(data.proc.decodingKeys);

      debug("initial decoding started: %d", decodingStarted);

      if (decodingStarted <= 0) {
        haveResolved = true;
        unsubscribe();
        resolve();
      }
    });
  }

  async variable(name) {
    await this.decodeReady();

    const definitions = this.view(data.current.identifiers.definitions);
    const refs = this.view(data.current.identifiers.refs);

    const decode = this.view(data.views.decoder);
    return await decode(definitions[name], refs[name]);
  }

  async variables() {
    debug("awaiting decodeReady");
    await this.decodeReady();
    debug("decode now ready");

    return await this.view(data.current.identifiers.decoded);
    debug("got variables");
  }
}
